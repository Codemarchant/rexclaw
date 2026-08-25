import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useReactive } from "../lib/reactive";
import { text } from "../services";
import { uiState } from "../lib/ui_state";
import { useReactive as useReactiveUi } from "../lib/reactive";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";
import Transcript from "./Transcript.jsx";
import { _t } from "../lib/i18n";
import { useFileDrop } from "../lib/use_file_drop";
import { screenCapture } from "../lib/screen_capture";

/** Text companion view, ported from the Odoo text_full_view. No avatar canvas
 *  — static agent thumbnail in the header, markdown transcript in the middle,
 *  input bar with paperclip + attachment chips at the bottom. */
export default function TextView({ active = true }) {
    const st = useReactive(text.state);
    const scap = useReactive(screenCapture.state);

    /** Arm/stop screen sharing for the screen-capture tools. Arming must
     *  happen in this click handler — getDisplayMedia needs the gesture. */
    const toggleScreenShare = async () => {
        if (screenCapture.isArmed) {
            screenCapture.disarm();
            return;
        }
        try {
            await screenCapture.arm();
        } catch (e) {
            notification.add(_t("Screen sharing failed: %s", e?.message || e), { type: "danger" });
        }
    };
    const [agents, setAgents] = useState([]);
    const [history, setHistory] = useState([]);
    const [selectedAgentId, setSelectedAgentId] = useState(null);
    const [showHistory, setShowHistory] = useState(false);
    const [draftText, setDraftText] = useState("");
    const [uploadingFile, setUploadingFile] = useState(false);
    const [dark, setDark] = useState(() => {
        try { return localStorage.getItem("rexclaw.text_dark") === "1"; } catch (e) { return false; }
    });
    // pendingFiles lives on the service (not reactive) — bump to re-render.
    const [, forceRender] = useState(0);
    const fileInputRef = useRef(null);
    const textInputRef = useRef(null);
    const rootRef = useRef(null);

    const isLive = st.status === "live";
    const isConnecting = st.status === "connecting";

    const loadHistory = useCallback(async () => {
        try {
            setHistory(await rpc("/api/text/sessions", { limit: 30 }));
        } catch (e) { /* silent — empty rail makes the issue obvious */ }
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const data = await rpc("/api/text/agents", {});
                const list = data.agents || [];
                setAgents(list);
                const candidates = [text.preferredAgentId, data.default_agent_id, list[0]?.id];
                for (const id of candidates) {
                    if (id && list.some((a) => a.id === Number(id))) {
                        setSelectedAgentId(Number(id));
                        break;
                    }
                }
            } catch (e) { /* silent */ }
            loadHistory();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fetch agents + history whenever this tab becomes active so changes
    // made in Settings show up without a reload.
    useEffect(() => {
        if (!active) return;
        (async () => {
            try {
                const data = await rpc("/api/text/agents", {});
                setAgents(data.agents || []);
            } catch (e) { /* silent */ }
            loadHistory();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    // Resume handoff from the Sessions tab (see VoiceView for the pattern).
    const ui = useReactiveUi(uiState);
    useEffect(() => {
        const pr = uiState.pendingResume;
        if (!active || !pr || pr.mode !== "text") return;
        uiState.pendingResume = null;
        (async () => {
            const ok = await text.start(pr.agentId, pr.sessionId);
            if (ok !== false && pr.agentId) {
                setSelectedAgentId(pr.agentId);
                text.preferredAgentId = pr.agentId;
            }
            loadHistory();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, ui.pendingResume]);

    useEffect(() => {
        if (!agents.length) return;
        if (!agents.some((a) => Number(a.id) === Number(selectedAgentId))) {
            setSelectedAgentId(agents[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents]);

    // Auto-grow the draft textarea.
    useEffect(() => {
        const el = textInputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
    }, [draftText]);

    const toggleDark = () => {
        setDark((prev) => {
            try { localStorage.setItem("rexclaw.text_dark", !prev ? "1" : "0"); } catch (e) { /* ignore */ }
            return !prev;
        });
    };

    const startSession = async () => {
        await text.start(selectedAgentId);
        loadHistory();
    };

    const endSession = async () => {
        await text.end("client");
        loadHistory();
    };

    // Offered only while the live response chain carries an older prompt
    // than a fresh one would (st.promptStale, server-computed).
    const refreshPrompt = async () => {
        const ok = await confirmAsk(_t(
            "The companion's prompt, persona or memories have changed since this "
            + "conversation's context was set up, and the ongoing chat is still "
            + "using the older version.\n\nRefresh it? Your next message will "
            + "re-send the full conversation once (extra tokens for that one "
            + "turn), and every reply after that uses the latest version."));
        if (!ok) return;
        await text.refreshPrompt();
    };

    const resumeSession = async (sess) => {
        const ok = await text.start(selectedAgentId, sess.id);
        if (ok === false) return;
        if (sess?.agent_id && agents.some((a) => a.id === sess.agent_id)) {
            setSelectedAgentId(sess.agent_id);
            text.preferredAgentId = sess.agent_id;
        }
        setShowHistory(false);
        loadHistory();
    };

    const lastResumableSession = useMemo(() => {
        const agentId = Number(selectedAgentId);
        if (!agentId) return null;
        // History first (it refreshes after every start/end); the per-agent
        // field from /text/agents covers conversations too old to make the
        // recent-history window (e.g. imported companions' sessions, which
        // keep their original dates).
        return (history || []).find(
            (s) => s.agent_id === agentId && (s.state === "ended" || s.state === "active"),
        ) || agents.find((a) => a.id === agentId)?.last_resumable_session || null;
    }, [selectedAgentId, history, agents]);

    const onAgentChange = (ev) => {
        const id = parseInt(ev.target.value, 10) || null;
        setSelectedAgentId(id);
        text.preferredAgentId = id;
    };

    const pickFile = () => fileInputRef.current?.click();

    const addFiles = async (files) => {
        if (!files.length) return;
        setUploadingFile(true);
        for (const file of files) {
            try {
                await text.uploadFile(file);
            } catch (e) {
                notification.add(e?.message || _t("Upload failed"), { type: "danger" });
            }
        }
        setUploadingFile(false);
        forceRender((n) => n + 1);
    };

    const onFileSelected = (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = "";
        addFiles(files);
    };

    // Drag & drop anywhere on the chat view queues files exactly like the
    // paperclip (they wait as chips until the message is sent).
    useFileDrop(rootRef, addFiles, active && !st.compacting);

    const removeFile = (fileId) => {
        text.removePendingFile(fileId);
        forceRender((n) => n + 1);
    };

    const sendMessage = async () => {
        const sent = await text.sendText(draftText);
        if (sent) setDraftText("");
        forceRender((n) => n + 1);
    };

    const onTextKeydown = (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            sendMessage();
        }
    };

    const dismissError = () => {
        text.state.errorMessage = null;
        if (text.state.status === "error") text.state.status = "idle";
    };

    const currentAgent = agents.find((a) => a.id === Number(selectedAgentId));
    const agentInitial = ((st.agentName || currentAgent?.name || "").trim()[0] || "•").toUpperCase();
    // Portrait follows the dropdown selection (the agents list carries each
    // companion's thumbnail); the live session's copy is the fallback.
    const agentThumbnailUrl = currentAgent?.chat_thumbnail_url || text.agentThumbnailUrl || null;
    const pendingFiles = text.pendingFiles || [];

    const tokenBudgetLabel = st.tokenLimit > 0
        ? `${(st.tokenUsage || 0).toLocaleString()} / ${st.tokenLimit.toLocaleString()}`
        : null;

    const statusLabel = (() => {
        if (st.compacting) return _t("Compacting context…");
        switch (st.status) {
            case "idle": return _t("Ready");
            case "connecting": return _t("Connecting…");
            case "live": return _t("Ready");
            case "ending": return _t("Ending…");
            case "ended": return _t("Ended");
            case "error": return st.errorMessage || _t("Error");
            default: return st.status;
        }
    })();

    return (
        <div className={"o_text_full_view rx_dropzone" + (dark ? " o_text_full_view--dark" : "")}
             ref={rootRef} data-drop-hint={_t("Drop files to attach")}>
            {showHistory && (
                <div className="o_text_full_history">
                    <div className="o_text_full_history_header"><strong>{_t("History")}</strong></div>
                    {!history.length && <p className="text-muted small p-3">{_t("No previous chats yet.")}</p>}
                    {history.map((sess) => (
                        <div key={sess.id} className="o_text_history_item">
                            <div className="o_text_history_meta">
                                <strong>{sess.name}</strong>
                                <span className="o_text_history_state">{sess.state}</span>
                            </div>
                            <div className="o_text_history_sub">
                                <span>{sess.agent_name}</span> · <span>{sess.message_count}</span> {_t("messages")}
                            </div>
                            <button className="btn btn-sm btn-link p-0" onClick={() => resumeSession(sess)}>
                                {_t("Resume")}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="o_text_full_main">
                <div className="o_text_full_header">
                    <div className="o_text_full_header_inner">
                        <div className="o_text_full_agent_picker">
                            {agentThumbnailUrl ? (
                                <img className="o_text_agent_thumb" src={agentThumbnailUrl} alt="agent" />
                            ) : (
                                <div className="o_text_agent_thumb o_text_agent_thumb--placeholder">{agentInitial}</div>
                            )}
                            <div className="o_text_full_agent_meta">
                                <select value={selectedAgentId ?? ""} onChange={onAgentChange}
                                        disabled={isLive || isConnecting}
                                        title={_t("Companion to chat with")}>
                                    {agents.map((agent) => (
                                        <option key={agent.id} value={agent.id}>{agent.name}</option>
                                    ))}
                                </select>
                                <div className="o_text_full_agent_sub">
                                    <span className="o_text_full_status">{statusLabel}</span>
                                    {tokenBudgetLabel && (
                                        <span className="o_text_token_budget"
                                              title={_t("Tokens used since the last summary rollup.")}>
                                            {tokenBudgetLabel}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="o_text_full_header_spacer" />
                        <button className="btn btn-light" onClick={toggleDark}
                                title={dark ? _t("Light theme") : _t("Dark theme")}>
                            <i className={dark ? "fa fa-sun-o" : "fa fa-moon-o"} />
                        </button>
                        {screenCapture.isSupported && (
                            <button className={"btn btn-light" + (scap.armed ? " active" : "")}
                                    onClick={toggleScreenShare}
                                    title={scap.recording
                                        ? _t("Recording your screen…")
                                        : scap.armed
                                            ? _t("Stop screen sharing")
                                            : _t("Share your screen — lets the companion take screenshots or record clips of it on request")}>
                                <i className={scap.recording ? "fa fa-circle text-danger" : "fa fa-desktop"} />
                            </button>
                        )}
                        <button className="btn btn-light" onClick={() => setShowHistory(!showHistory)}
                                title={showHistory ? _t("Hide history") : _t("Show history")}>
                            <i className="fa fa-history" />
                        </button>
                        {/* Resume last leads (primary) when available — continuing the
                            rolling conversation is the intended default; Start chat is
                            the deliberate fresh-session choice. */}
                        {!isLive && !isConnecting && lastResumableSession && (
                            <button className="btn btn-primary"
                                    title={_t("Resume %s", lastResumableSession.name)}
                                    onClick={() => resumeSession(lastResumableSession)}>
                                <i className="fa fa-history" /> {_t("Resume last")}
                            </button>
                        )}
                        {!isLive && !isConnecting && (
                            <button className={"btn " + (lastResumableSession ? "btn-secondary" : "btn-primary")}
                                    onClick={startSession}>
                                <i className="fa fa-comments" /> {_t(lastResumableSession ? "New chat" : "Start chat")}
                            </button>
                        )}
                        {isLive && st.promptStale && (
                            <button className="btn btn-light o_text_prompt_stale" onClick={refreshPrompt}
                                    title={_t("The companion's prompt, persona or memories changed — refresh this conversation to use the latest version")}>
                                <i className="fa fa-refresh" />
                            </button>
                        )}
                        {(isLive || isConnecting) && (
                            <button className="btn btn-danger" onClick={endSession}>
                                <i className="fa fa-stop" /> {_t("End")}
                            </button>
                        )}
                    </div>
                </div>

                {st.errorMessage && (
                    <div className="o_text_error">
                        <strong>{_t("Error:")}</strong> {st.errorMessage}
                        <button className="btn btn-link p-0 float-end" onClick={dismissError} title={_t("Dismiss")}>
                            <i className="fa fa-times" />
                        </button>
                    </div>
                )}

                <div className="o_text_full_transcript">
                    <Transcript messages={st.messages} isLive={isLive} thinking={st.thinking}
                                mode="text" agentThumbnailUrl={agentThumbnailUrl || false}
                                agentInitial={agentInitial} />
                </div>

                {isLive && (
                    <div className="o_text_input_bar">
                        {pendingFiles.length > 0 && (
                            <div className="o_text_pending_files">
                                {pendingFiles.map((f, fIdx) => (
                                    <span key={`${f.xai_file_id}-${fIdx}`} className="o_text_file_chip" title={f.filename}>
                                        <i className="fa fa-paperclip" /> <span>{f.filename}</span>
                                        <button className="o_text_chip_remove" title={_t("Remove")}
                                                onClick={() => removeFile(f.xai_file_id)}>
                                            <i className="fa fa-times" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="o_text_input_row">
                            <button className="btn btn-light" onClick={pickFile}
                                    disabled={uploadingFile || st.compacting} title={_t("Attach a file")}>
                                <i className={uploadingFile ? "fa fa-spinner fa-spin" : "fa fa-paperclip"} />
                            </button>
                            <input type="file" multiple style={{ display: "none" }}
                                   ref={fileInputRef} onChange={onFileSelected} />
                            <textarea rows={1}
                                      ref={textInputRef}
                                      placeholder={st.compacting ? _t("Compacting context…") : _t("Type a message…")}
                                      value={draftText}
                                      disabled={st.compacting || st.thinking}
                                      onChange={(ev) => setDraftText(ev.target.value)}
                                      onKeyDown={onTextKeydown} />
                            <button className="btn btn-primary"
                                    disabled={(!draftText.trim() && !pendingFiles.length) || st.compacting || st.thinking}
                                    onClick={sendMessage} title={_t("Send")}>
                                <i className="fa fa-paper-plane" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
