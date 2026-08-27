import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { confirmAsk } from "../lib/confirm";
import Pager, { usePager } from "./Pager.jsx";
import { uiState } from "../lib/ui_state";
import Transcript from "./Transcript.jsx";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { EditorBar } from "./UnsavedUI.jsx";

// Summaries longer than this get the 2-line clamp plus a More/Less toggle;
// shorter ones fit the clamp anyway, so no toggle is shown.
const SUMMARY_CLAMP_CHARS = 180;

/** Sessions tab — the full conversation archive (voice + text), mirroring the
 *  Memories tab pattern: search + filters, expandable read-only transcripts,
 *  rename and delete. Reading a session here never reactivates it (no xAI
 *  traffic) — Resume hands off to the Voice/Chat tab for that. Group-call
 *  peer legs nest under their primary session. */
export default function SessionsView({ active }) {
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [modeFilter, setModeFilter] = useState("all");    // all | voice | text
    const [agentFilter, setAgentFilter] = useState("all");  // all | <agent name>
    const [expanded, setExpanded] = useState(() => new Set());
    const [transcripts, setTranscripts] = useState({});     // id → {mode, messages}
    // Companion name → chat thumbnail URL, so text transcripts draw the
    // portrait beside each reply (per speaker in group calls).
    const [thumbnails, setThumbnails] = useState({});
    const [renamingId, setRenamingId] = useState(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [summaryOpen, setSummaryOpen] = useState(() => new Set());  // ids showing the full summary
    const [summaryEdit, setSummaryEdit] = useState(null);   // null | {id, text, baseline}
    const [savingSummary, setSavingSummary] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            setSessions(await rpc("/api/sessions/list", {}));
        } catch (e) {
            notification.add(e?.message || _t("Could not load sessions"), { type: "danger" });
        } finally {
            setLoading(false);
        }
        try {
            const data = await rpc("/api/text/agents", {});
            setThumbnails(Object.fromEntries(
                (data.agents || []).map((a) => [a.name, a.chat_thumbnail_url || null]),
            ));
        } catch (e) { /* silent — transcripts fall back to initials */ }
    };

    useEffect(() => {
        if (active) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const toggleExpand = async (id) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
        if (!transcripts[id]) {
            try {
                const t = await rpc("/api/sessions/messages", { id });
                setTranscripts((t0) => ({ ...t0, [id]: t }));
            } catch (e) {
                notification.add(e?.message || _t("Could not load the transcript"), { type: "danger" });
            }
        }
    };

    const deleteSession = async (s, hasPeers) => {
        const msg = hasPeers
            ? _t("Delete session \"%s\"? Its messages are removed permanently. The linked group-call sessions of other companions are kept (they become top-level).", s.name)
            : _t("Delete session \"%s\"? Its messages are removed permanently.", s.name);
        if (!(await confirmAsk(msg))) return;
        try {
            await rpc("/api/sessions/delete", { id: s.id });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const startRename = (s) => {
        setRenamingId(s.id);
        setRenameDraft(s.name || "");
    };

    const commitRename = async () => {
        const id = renamingId;
        const name = renameDraft.trim();
        setRenamingId(null);
        if (!id || !name) return;
        try {
            await rpc("/api/sessions/rename", { id, name });
            setSessions((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));
        } catch (e) {
            notification.add(e?.message || _t("Rename failed"), { type: "danger" });
        }
    };

    const toggleSummary = (id) =>
        setSummaryOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });

    const startSummaryEdit = (s) =>
        setSummaryEdit({ id: s.id, text: s.summary || "", baseline: s.summary || "" });

    const summaryDirty = !!summaryEdit && summaryEdit.text !== summaryEdit.baseline;

    const saveSummary = async () => {
        if (!summaryEdit) return;
        const { id } = summaryEdit;
        const summary = summaryEdit.text.trim();
        if (!summary) {
            notification.add(_t("Summary cannot be empty."), { type: "warning" });
            return;
        }
        setSavingSummary(true);
        try {
            await rpc("/api/sessions/summary", { id, summary });
            setSessions((list) => list.map((s) => (s.id === id ? { ...s, summary } : s)));
            setSummaryEdit(null);
        } catch (e) {
            notification.add(e?.message || _t("Could not save the summary"), { type: "danger" });
        } finally {
            setSavingSummary(false);
        }
    };

    // Leaving the tab mid-edit prompts Save / Discard like the other editors.
    useUnsavedGuard(active, summaryDirty, saveSummary, () => setSummaryEdit(null));

    /** Hand off to the Voice/Chat tab, which owns the live-session plumbing.
     *  The target view picks pendingResume up in an effect once active. */
    const resume = (s) => {
        uiState.pendingResume = { mode: s.mode, sessionId: s.id, agentId: s.agent_id };
        uiState.requestedTab = s.mode === "text" ? "chat" : "voice";
    };

    // ---- filtering + nesting ------------------------------------------------

    const agentNames = [...new Set(sessions.map((s) => s.agent_name).filter(Boolean))];
    const q = query.trim().toLowerCase();
    const matches = (s) => {
        if (modeFilter !== "all" && s.mode !== modeFilter) return false;
        if (agentFilter !== "all" && s.agent_name !== agentFilter) return false;
        if (!q) return true;
        return [s.name, s.summary, s.agent_name].some((f) => (f || "").toLowerCase().includes(q));
    };

    // Peer legs nest under their primary session; a child whose parent is
    // missing (deleted) or filtered out surfaces top-level so it never
    // silently disappears.
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const childrenOf = new Map();
    for (const s of sessions) {
        if (s.call_parent_session_id && byId.has(s.call_parent_session_id)) {
            const arr = childrenOf.get(s.call_parent_session_id) || [];
            arr.push(s);
            childrenOf.set(s.call_parent_session_id, arr);
        }
    }
    const rows = [];
    for (const s of sessions) {
        const parent = s.call_parent_session_id && byId.get(s.call_parent_session_id);
        if (parent && matches(parent)) continue;  // rendered nested below its parent
        if (!matches(s)) continue;
        rows.push({ session: s, child: false });
        for (const c of childrenOf.get(s.id) || []) {
            rows.push({ session: c, child: true });
        }
    }

    const pager = usePager(rows.length);

    const voiceCount = sessions.filter((s) => s.mode === "voice").length;
    const textCount = sessions.length - voiceCount;

    const fmtDate = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-archive" /> {_t("Sessions")}</h3>
                    <p className="text-muted small" style={{ marginTop: "-0.4rem" }}>
                        {_t("Every conversation you've had, voice and text — read the transcript, rename, resume, or delete. Reading here never reconnects to xAI.")}
                    </p>

                    <div className="rx_mem_toolbar">
                        <input
                            type="text"
                            placeholder={_t("Search titles, summaries, companions…")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        <div className="rx_mem_filters">
                            {[
                                ["all", `${_t("All")} ${sessions.length}`],
                                ["voice", `${_t("Voice")} ${voiceCount}`],
                                ["text", `${_t("Chat")} ${textCount}`],
                            ].map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className={"rx_mem_chip" + (modeFilter === id ? " is-active" : "")}
                                    onClick={() => setModeFilter(id)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <select
                            value={agentFilter}
                            onChange={(e) => setAgentFilter(e.target.value)}
                            style={{ width: "auto" }}
                            title={_t("Filter by companion")}
                        >
                            <option value="all">{_t("All companions")}</option>
                            {agentNames.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                    </div>

                    {loading && <p className="text-muted small">{_t("Loading…")}</p>}
                    {!loading && !sessions.length && (
                        <p className="text-muted small">{_t("No sessions yet — start a conversation on the Voice or Chat tab.")}</p>
                    )}
                    {!loading && !!sessions.length && !rows.length && (
                        <p className="text-muted small">{_t("No sessions match your filters.")}</p>
                    )}

                    <Pager pager={pager} />
                    {pager.slice(rows).map(({ session: s, child }) => {
                        const isOpen = expanded.has(s.id);
                        const t = transcripts[s.id];
                        const hasPeers = (childrenOf.get(s.id) || []).length > 0;
                        const summary = s.summary || "";
                        const summaryLong = summary.length > SUMMARY_CLAMP_CHARS || summary.split("\n").length > 2;
                        const summaryShown = summaryOpen.has(s.id);
                        const editingSummary = summaryEdit?.id === s.id;
                        return (
                            <div key={s.id} className={"rx_sess_item" + (child ? " rx_sess_item--child" : "")}>
                                <div className="rx_sess_head">
                                    <i className={"fa " + (s.mode === "text" ? "fa-comments" : "fa-microphone")}
                                       title={s.mode === "text" ? _t("Chat") : _t("Voice")} />
                                    {child && <i className="fa fa-level-up fa-rotate-90 rx_sess_child_mark"
                                                 title={_t("Joined this group call")} />}
                                    {renamingId === s.id ? (
                                        <input
                                            className="rx_sess_rename"
                                            autoFocus
                                            value={renameDraft}
                                            onChange={(e) => setRenameDraft(e.target.value)}
                                            onBlur={commitRename}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") commitRename();
                                                if (e.key === "Escape") setRenamingId(null);
                                            }}
                                        />
                                    ) : (
                                        <strong className="rx_sess_title" title={s.name}>{s.name}</strong>
                                    )}
                                    <span className="rx_sess_meta">
                                        {s.agent_name || "?"} · {s.message_count} {_t("messages")}
                                        {" · "}{fmtDate(s.last_active_at)}
                                        {s.state === "active" ? ` · ${_t("active")}` : ""}
                                    </span>
                                    <span className="rx_sess_actions">
                                        <button className="btn btn-sm btn-link p-0"
                                                title={isOpen ? _t("Hide transcript") : _t("Read transcript")}
                                                onClick={() => toggleExpand(s.id)}>
                                            <i className={"fa " + (isOpen ? "fa-chevron-up" : "fa-book")} />
                                        </button>
                                        <button className="btn btn-sm btn-link p-0" title={_t("Resume this session")}
                                                onClick={() => resume(s)}>
                                            <i className="fa fa-play-circle-o" />
                                        </button>
                                        <button className="btn btn-sm btn-link p-0" title={_t("Rename")}
                                                onClick={() => startRename(s)}>
                                            <i className="fa fa-pencil" />
                                        </button>
                                        <button className="btn btn-sm btn-link p-0" title={_t("Delete session")}
                                                disabled={s.state === "active"}
                                                onClick={() => deleteSession(s, hasPeers)}>
                                            <i className="fa fa-trash-o" />
                                        </button>
                                    </span>
                                </div>
                                {editingSummary ? (
                                    <div className="rx_sess_summary_editor">
                                        <label>{_t("Conversation summary")}</label>
                                        <textarea
                                            autoFocus
                                            value={summaryEdit.text}
                                            onChange={(e) => setSummaryEdit({ ...summaryEdit, text: e.target.value })}
                                            onKeyDown={(e) => { if (e.key === "Escape") setSummaryEdit(null); }}
                                        />
                                        <p className="text-muted small">
                                            {_t("This is what the companion remembers of the conversation when it is resumed — edit it to correct or reshape that memory.")}
                                        </p>
                                        <EditorBar
                                            dirty={summaryDirty}
                                            saving={savingSummary}
                                            onSave={saveSummary}
                                            onCancel={() => setSummaryEdit(null)}
                                        />
                                    </div>
                                ) : summary ? (
                                    <div className="rx_sess_summary">
                                        <p className={"rx_sess_summary_text" + (summaryLong && !summaryShown ? " is-clamped" : "")}>
                                            {summary}
                                        </p>
                                        <div className="rx_sess_summary_tools">
                                            {summaryLong && (
                                                <button type="button" className="btn btn-link p-0"
                                                        onClick={() => toggleSummary(s.id)}>
                                                    {summaryShown ? _t("Show less") : _t("Show more")}
                                                </button>
                                            )}
                                            <button type="button" className="btn btn-link p-0"
                                                    title={_t("Edit summary")}
                                                    onClick={() => startSummaryEdit(s)}>
                                                <i className="fa fa-pencil-square-o" /> {_t("Edit summary")}
                                            </button>
                                        </div>
                                    </div>
                                ) : null}
                                {isOpen && (
                                    <div className="rx_sess_transcript">
                                        {!t && <p className="text-muted small" style={{ padding: "0.5rem" }}>{_t("Loading…")}</p>}
                                        {t && !t.messages.length && (
                                            <p className="text-muted small" style={{ padding: "0.5rem" }}>{_t("This session has no messages.")}</p>
                                        )}
                                        {t && !!t.messages.length && (
                                            <Transcript
                                                messages={t.messages}
                                                isLive={false}
                                                mode={t.mode === "text" ? "text" : "voice"}
                                                agentInitial={(t.agent_name || "•").trim()[0]?.toUpperCase() || "•"}
                                                agentThumbnailUrl={thumbnails[t.agent_name] || null}
                                                speakerThumbnails={thumbnails}
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </section>
            </div>
        </div>
    );
}
