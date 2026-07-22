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
            }
        } catch (_) {
            // result wasn't JSON — fine for non-imagine tools.
        }
    }
    return row;
}

/** Collapse consecutive tool_call + tool_result messages into display rows. */
function buildDisplayRows(messages) {
    const rows = [];
    const msgs = messages || [];
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const next = msgs[i + 1];
        // Summary rollups are a backend artifact — the user's visible
        // transcript shows the full conversation.
        if (m.is_summary_rollup) continue;
        if (m.role === "tool_call" && next?.role === "tool_result") {
            rows.push(toolRow({
                key: `tcr-${m.sequence}-${next.sequence}`,
                tool_name: m.tool_name || next.tool_name || "tool",
                args: m.tool_arguments_json || "",
                result: next.content || "",
                pending: false,
            }));
            i++;
        } else if (m.role === "tool_call") {
            rows.push(toolRow({
                key: `tc-${m.sequence}`,
                tool_name: m.tool_name || "tool",
                args: m.tool_arguments_json || "",
                result: "",
                pending: true,
            }));
        } else if (m.role === "tool_result") {
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
    const lastCount = useRef(0);
    const isTextMode = mode === "text";

    // Auto-scroll to the latest message when new ones arrive (or on mount
    // with existing history). Walk up to the nearest scrollable ancestor —
    // in text mode the scroll is hoisted to the parent.
    useEffect(() => {
        const count = (messages || []).length;
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
    const rows = buildDisplayRows(messages);

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
                const isMdAssistant = isTextMode && msg.role === "assistant";
                return (
                    <div key={row.key} className={classFor(msg.role)}>
                        {isMdAssistant ? (
                            <>
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
                                        dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(msg.content || "") }}
                                    />
                                </div>
                                {msg.incomplete_reason && (
                                    <div
                                        className="o_voice_msg_incomplete"
                                        title={_t("Reply was truncated by xAI: %s", msg.incomplete_reason)}
                                    >
                                        <i className="fa fa-warning" /> {msg.incomplete_reason}
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                {/* Group calls stamp assistant rows with the speaking
                                    agent's name — show it instead of the generic role
                                    so three-way exchanges read clearly. */}
                                <div className="o_voice_msg_role">{msg.speaker || msg.role}</div>
                                <div className="o_voice_msg_content">{msg.content || ""}</div>
                            </>
                        )}
                        {msg.attachments && msg.attachments.length > 0 && (
                            <div className="o_voice_msg_attachments">
                                {msg.attachments.map((att) => (
                                    <span
                                        key={att.xai_file_id}
                                        className="o_voice_msg_attachment_chip"
                                        title={att.filename + (att.size_bytes ? ` (${att.size_bytes} bytes)` : "")}
                                    >
                                        <i className="fa fa-paperclip" /> <span>{att.filename}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
            {thinking && (
                <div className="o_voice_transcript_thinking" aria-label="Assistant is thinking">
                    <span /><span /><span />
                </div>
            )}
        </div>
    );
}
