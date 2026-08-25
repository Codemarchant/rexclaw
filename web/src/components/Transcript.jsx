import { _t } from "../lib/i18n";
import React, { useEffect, useRef, useState } from "react";

/** Transcript renderer, ported from the OWL component. Voice mode renders
 *  plain text; text mode renders markdown for assistant content, draws the
 *  agent thumbnail beside assistant rows, and shows attachment chips on user
 *  messages. Consecutive tool_call + tool_result messages collapse into one
 *  accordion row. */

/** Tiny markdown renderer: HTML-escapes input first, then re-introduces a
 *  whitelist of safe constructs (paragraphs, line breaks, bold, italic,
 *  inline code, fenced code, links to http(s)/mailto, headings, lists). */
function markdownToSafeHtml(text) {
    if (!text) return "";
    let s = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    s = s.replace(/```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const langClass = lang ? ` class="language-${lang.replace(/[^a-zA-Z0-9_+\-]/g, "")}"` : "";
        return `<pre><code${langClass}>${code.replace(/\n$/, "")}</code></pre>`;
    });
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    s = s.replace(/^### (.+)$/gm, "<h4>$1</h4>");
    s = s.replace(/^## (.+)$/gm, "<h3>$1</h3>");
    s = s.replace(/^# (.+)$/gm, "<h2>$1</h2>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    s = s.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, (match) => {
        const items = match.trim().split(/\n/).map((ln) => ln.replace(/^[ \t]*[-*] /, "")).map((it) => `<li>${it}</li>`).join("");
        return `<ul>${items}</ul>`;
    });
    s = s.replace(/((?:^[ \t]*\d+\. .+(?:\n|$))+)/gm, (match) => {
        const items = match.trim().split(/\n/).map((ln) => ln.replace(/^[ \t]*\d+\. /, "")).map((it) => `<li>${it}</li>`).join("");
        return `<ol>${items}</ol>`;
    });
    const blocks = s.split(/\n{2,}/);
    const blockTagRe = /^\s*<(?:h\d|ul|ol|pre|blockquote|p|div|table|hr)\b/i;
    s = blocks.map((b) => {
        if (!b.trim()) return "";
        if (blockTagRe.test(b)) return b;
        return `<p>${b.replace(/\n/g, "<br/>")}</p>`;
    }).filter(Boolean).join("");
    return s;
}

/** Text mode lets the model send several "texts" in one reply by putting
 *  `[next]` on its own line between them (see the text-mode Surface prompt
 *  in session_service). The reply is stored as ONE row with the tags in it —
 *  the model sees its own format on resume — and is split into bubbles only
 *  here. A reply without the tag is one bubble. */
const NEXT_TAG_RE = /^[ \t]*\[next\][ \t]*$/im;
function splitBubbles(content) {
    const parts = (content || "").split(NEXT_TAG_RE).map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : [content || ""];
}

// Pause before each follow-up bubble, scaled by its length like someone
// typing it, bounded so long texts don't stall the conversation.
function revealDelayMs(chunk) {
    return Math.min(2200, 450 + chunk.length * 18);
}

function classFor(role) {
    switch (role) {
        case "user": return "o_voice_msg o_voice_msg--user";
        case "assistant": return "o_voice_msg o_voice_msg--assistant";
        case "tool_call": return "o_voice_msg o_voice_msg--tool";
        case "tool_result": return "o_voice_msg o_voice_msg--tool-result";
        case "system": return "o_voice_msg o_voice_msg--system";
        default: return "o_voice_msg";
    }
}

function pretty(value) {
    if (!value) return "";
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch (e) {
        return value;
    }
}

/** Build a kind='tool' row, opportunistically pulling image_url out of a JSON
 *  result so the template can surface a clickable thumbnail for Grok-Imagine
 *  create_image / change_background results. */
function toolRow(base) {
    const row = { kind: "tool", ...base };
    if (row.result) {
        try {
            const parsed = JSON.parse(row.result);
            if (parsed && typeof parsed === "object" && parsed.image_url) {
                row.image_url = parsed.image_url;
                row.image_name = parsed.name || parsed.prompt || _t("Generated image");
                row.image_prompt = parsed.prompt || "";
            } else if (parsed && typeof parsed === "object" && parsed.video_url) {
                row.video_url = parsed.video_url;
                row.video_name = parsed.name || parsed.prompt || _t("Generated video");
                row.video_prompt = parsed.prompt || "";
            }
        } catch (_) {
            // result wasn't JSON — fine for non-imagine tools.
        }
    }
    return row;
}

/** Collapse tool_call + tool_result message pairs into display rows.
 *
 *  Pairing is by xAI call id when both rows carry one: with parallel tool
 *  calls the stream interleaves (call A, call B, result B, result A), so
 *  naive adjacency merges a call with a NEIGHBOUR'S result and strands the
 *  real one as a duplicate row. Id-less rows (live text-mode pairs, and
 *  history persisted before call ids existed) fall back to claiming the
 *  nearest following unclaimed id-less result with a matching tool name,
 *  bounded by the next spoken turn. */
// Tool rows that persist (the model needs the result on resume) but are
// noise in the transcript: the score change is a silent background
// mechanic the companion is told never to mention.
const HIDDEN_TOOLS = new Set(["adjust_affection"]);

function buildDisplayRows(messages) {
    const rows = [];
    const msgs = messages || [];
    // First occurrence of each call id among results, by index.
    const resultIdxByCallId = new Map();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.role === "tool_result" && m.xai_call_id && !resultIdxByCallId.has(m.xai_call_id)) {
            resultIdxByCallId.set(m.xai_call_id, i);
        }
    }
    const claimed = new Set(); // result indices already merged into a call row
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        // Summary rollups are a backend artifact — the user's visible
        // transcript shows the full conversation.
        if (m.is_summary_rollup) continue;
        if ((m.role === "tool_call" || m.role === "tool_result") && HIDDEN_TOOLS.has(m.tool_name)) continue;
        if (m.role === "tool_call") {
            let ri = m.xai_call_id ? resultIdxByCallId.get(m.xai_call_id) : undefined;
            if (ri !== undefined && claimed.has(ri)) ri = undefined; // duplicate call rows
            if (ri === undefined && !m.xai_call_id) {
                // Id-less fallback (legacy rows persisted before call ids):
                // claim the nearest FOLLOWING unclaimed id-less result with a
                // matching tool name. Parallel calls interleave (call A,
                // call B, result A, result B), so strict next-row adjacency
                // strands pairs. Stop at the next spoken turn — a burst's
                // results always land before the model speaks again.
                for (let j = i + 1; j < msgs.length; j++) {
                    const c = msgs[j];
                    if (c.role === "user" || c.role === "assistant") break;
                    if (c.role !== "tool_result" || c.xai_call_id || claimed.has(j)) continue;
                    if (c.tool_name && m.tool_name && c.tool_name !== m.tool_name) continue;
                    ri = j;
                    break;
                }
            }
            const result = ri === undefined ? null : msgs[ri];
            if (result) {
                claimed.add(ri);
                rows.push(toolRow({
                    key: `tcr-${m.sequence}-${result.sequence}`,
                    tool_name: m.tool_name || result.tool_name || "tool",
                    args: m.tool_arguments_json || "",
                    result: result.content || "",
                    pending: false,
                }));
            } else {
                rows.push(toolRow({
                    key: `tc-${m.sequence}`,
                    tool_name: m.tool_name || "tool",
                    args: m.tool_arguments_json || "",
                    result: "",
                    pending: true,
                }));
            }
        } else if (m.role === "tool_result") {
            if (claimed.has(i)) continue;
            rows.push(toolRow({
                key: `tr-${m.sequence}`,
                tool_name: m.tool_name || "tool",
                args: "",
                result: m.content || "",
                pending: false,
            }));
        } else {
            rows.push({ kind: "msg", key: `m-${m.sequence}`, msg: m });
        }
    }
    return rows;
}

export default function Transcript({
    messages,
    isLive = false,
    thinking = false,
    mode = "voice",
    agentThumbnailUrl = null,
    agentInitial = "•",
    truncated = false,
}) {
    const scrollRef = useRef(null);
    const [expanded, setExpanded] = useState({});
    const lastCount = useRef("");
    const isTextMode = mode === "text";
    const rows = buildDisplayRows(messages);

    // Paced reveal of `[next]`-split replies: row.key → bubbles shown so far.
    // Only a reply that arrived live (msg.fresh, set by text_service) is
    // paced; history, resume and the Sessions tab show every bubble at once.
    const [revealed, setRevealed] = useState({});
    const isMdAssistantRow = (row) => row.kind !== "tool" && isTextMode && row.msg.role === "assistant";
    useEffect(() => {
        const updates = {};
        for (const row of rows) {
            if (!isMdAssistantRow(row) || revealed[row.key] !== undefined) continue;
            const n = splitBubbles(row.msg.content).length;
            updates[row.key] = isLive && row.msg.fresh ? 1 : n;
        }
        if (Object.keys(updates).length) setRevealed((r) => ({ ...r, ...updates }));
    });
    const pendingRow = rows.find((row) =>
        isMdAssistantRow(row) && revealed[row.key] !== undefined
        && revealed[row.key] < splitBubbles(row.msg.content).length);
    const pendingKey = pendingRow?.key || null;
    const pendingShown = pendingKey ? revealed[pendingKey] : 0;
    useEffect(() => {
        if (!pendingKey) return undefined;
        const chunks = splitBubbles(pendingRow.msg.content);
        const t = setTimeout(
            () => setRevealed((r) => ({ ...r, [pendingKey]: (r[pendingKey] || 0) + 1 })),
            revealDelayMs(chunks[pendingShown] || ""),
        );
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingKey, pendingShown]);
    const revealTick = Object.values(revealed).reduce((a, b) => a + b, 0);

    // Auto-scroll to the latest message when new ones arrive (or on mount
    // with existing history, or as a paced bubble lands). Walk up to the
    // nearest scrollable ancestor — in text mode the scroll is hoisted to
    // the parent.
    useEffect(() => {
        const count = `${(messages || []).length}/${revealTick}`;
        if (count === lastCount.current) return;
        lastCount.current = count;
        const el = scrollRef.current;
        if (!el) return;
        let scroller = el;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
            scroller = scroller.parentElement;
        }
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });

    const toggleRow = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));
    const renderAttachments = (msg) => msg.attachments && msg.attachments.length > 0 && (
        <div className="o_voice_msg_attachments">
            {msg.attachments.map((att, attIdx) => (
                <span
                    key={`${att.xai_file_id}-${attIdx}`}
                    className="o_voice_msg_attachment_chip"
                    title={att.filename + (att.size_bytes ? ` (${att.size_bytes} bytes)` : "")}
                >
                    <i className="fa fa-paperclip" /> <span>{att.filename}</span>
                </span>
            ))}
        </div>
    );

    return (
        <div
            className={"o_voice_transcript" + (isTextMode ? " o_voice_transcript--text" : "")}
            ref={scrollRef}
        >
            {!rows.length && isLive && (
                <div className="o_voice_transcript_empty">
                    {isTextMode ? _t("Type a message to get started.") : _t("Say something to get started.")}
                </div>
            )}
            {truncated && (
                <div
                    className="o_voice_transcript_truncated"
                    title={_t("Earlier messages exist on the server but are not loaded in this view.")}
                >
                    <i className="fa fa-ellipsis-h" />
                    <span>{_t("Earlier messages not shown")}</span>
                </div>
            )}
            {rows.map((row) => {
                if (row.kind === "tool") {
                    return (
                        <div
                            key={row.key}
                            className={
                                "o_voice_msg o_voice_msg--tool"
                                + (expanded[row.key] ? " is-expanded" : "")
                                + (row.pending ? " is-pending" : "")
                            }
                        >
                            <button
                                type="button"
                                className="o_voice_tool_header"
                                onClick={() => toggleRow(row.key)}
                                aria-expanded={expanded[row.key] ? "true" : "false"}
                            >
                                <i className={expanded[row.key] ? "fa fa-caret-down" : "fa fa-caret-right"} />
                                <i className="fa fa-wrench o_voice_tool_icon" title="Tool call" />
                                <span className="o_voice_tool_name">{row.tool_name}</span>
                                {row.pending && (
                                    <span className="o_voice_tool_pending" title="Awaiting result">…</span>
                                )}
                            </button>
                            {row.image_url && (
                                <a
                                    className="o_voice_tool_image"
                                    href={row.image_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={row.image_prompt || row.image_name}
                                >
                                    <img src={row.image_url} alt={row.image_name} />
                                    <span className="o_voice_tool_image_label">{row.image_name}</span>
                                </a>
                            )}
                            {row.video_url && (
                                <div
                                    className="o_voice_tool_image o_voice_tool_video"
                                    title={row.video_prompt || row.video_name}
                                >
                                    <video src={row.video_url} controls preload="metadata" playsInline />
                                    <span className="o_voice_tool_image_label">{row.video_name}</span>
                                </div>
                            )}
                            {expanded[row.key] && (
                                <div className="o_voice_tool_details">
                                    {row.args && (
                                        <>
                                            <div className="o_voice_tool_section_label">arguments</div>
                                            <pre className="o_voice_tool_section">{pretty(row.args)}</pre>
                                        </>
                                    )}
                                    {row.result && (
                                        <>
                                            <div className="o_voice_tool_section_label">result</div>
                                            <pre className="o_voice_tool_section">{pretty(row.result)}</pre>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                }
                const msg = row.msg;
                if (isMdAssistantRow(row)) {
                    // One stored reply → one bubble per `[next]` segment, each
                    // with the portrait; truncation notice and attachments on
                    // the last.
                    const chunks = splitBubbles(msg.content);
                    const shown = Math.min(chunks.length, revealed[row.key] ?? chunks.length);
                    return chunks.slice(0, shown).map((chunk, i) => {
                        const last = i === chunks.length - 1;
                        return (
                            <div key={`${row.key}-${i}`}
                                 className={classFor("assistant") + (i ? " o_voice_msg--cont" : "")}>
                                <div className="o_voice_msg_assistant_layout">
                                    {agentThumbnailUrl ? (
                                        <img className="o_voice_msg_thumb" src={agentThumbnailUrl} alt="agent" />
                                    ) : (
                                        <div className="o_voice_msg_thumb o_voice_msg_thumb--placeholder">
                                            {agentInitial || "•"}
                                        </div>
                                    )}
                                    <div
                                        className="o_voice_msg_content o_voice_msg_content--md"
                                        dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(chunk) }}
                                    />
                                </div>
                                {last && msg.incomplete_reason && (
                                    <div
                                        className="o_voice_msg_incomplete"
                                        title={_t("Reply was truncated by xAI: %s", msg.incomplete_reason)}
                                    >
                                        <i className="fa fa-warning" /> {msg.incomplete_reason}
                                    </div>
                                )}
                                {last && renderAttachments(msg)}
                            </div>
                        );
                    });
                }
                // Voice-surface rendering. A text-mode reply resumed into a
                // voice session still carries `[next]` breaks — split it the
                // same way (no pacing), role label on the first bubble only.
                const chunks = msg.role === "assistant" ? splitBubbles(msg.content) : [msg.content || ""];
                return chunks.map((chunk, i) => (
                    <div key={`${row.key}-${i}`}
                         className={classFor(msg.role) + (i ? " o_voice_msg--cont" : "")}>
                        {/* Group calls stamp assistant rows with the speaking
                            agent's name — show it instead of the generic role
                            so three-way exchanges read clearly. */}
                        {!i && <div className="o_voice_msg_role">{msg.speaker || msg.role}</div>}
                        <div className="o_voice_msg_content">{chunk}</div>
                        {i === chunks.length - 1 && renderAttachments(msg)}
                    </div>
                ));
            })}
            {(thinking || !!pendingKey) && (
                <div className="o_voice_transcript_thinking" aria-label="Assistant is thinking">
                    <span /><span /><span />
                </div>
            )}
        </div>
    );
}
