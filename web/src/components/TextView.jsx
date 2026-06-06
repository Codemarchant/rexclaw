import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useReactive } from "../lib/reactive";
import { text } from "../services";
import { notification } from "../lib/notification";
import Transcript from "./Transcript.jsx";

/** Text companion view, ported from the Odoo text_full_view. No avatar canvas
 *  — static agent thumbnail in the header, markdown transcript in the middle,
 *  input bar with paperclip + attachment chips at the bottom. */
export default function TextView({ active = true }) {
    const st = useReactive(text.state);
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
        return (history || []).find(
            (s) => s.agent_id === agentId && (s.state === "ended" || s.state === "active"),
        ) || null;
    }, [selectedAgentId, history]);

    const onAgentChange = (ev) => {
        const id = parseInt(ev.target.value, 10) || null;
        setSelectedAgentId(id);
        text.preferredAgentId = id;
    };

    const pickFile = () => fileInputRef.current?.click();

    const onFileSelected = async (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = "";
        if (!files.length) return;
        setUploadingFile(true);
        for (const file of files) {
            try {
                await text.uploadFile(file);
            } catch (e) {
                notification.add(e?.message || "Upload failed", { type: "danger" });
            }
        }
        setUploadingFile(false);
        forceRender((n) => n + 1);
    };

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
    const pendingFiles = text.pendingFiles || [];

    const tokenBudgetLabel = st.tokenLimit > 0
        ? `${(st.tokenUsage || 0).toLocaleString()} / ${st.tokenLimit.toLocaleString()}`
        : null;

    const statusLabel = (() => {
        if (st.compacting) return "Compacting context…";
        switch (st.status) {
            case "idle": return "Ready";
            case "connecting": return "Connecting…";
            case "live": return "Ready";
            case "ending": return "Ending…";
            case "ended": return "Ended";
            case "error": return st.errorMessage || "Error";
            default: return st.status;
        }
    })();

    return (
        <div className={"o_text_full_view" + (dark ? " o_text_full_view--dark" : "")}>
            {showHistory && (
                <div className="o_text_full_history">
                    <div className="o_text_full_history_header"><strong>History</strong></div>
                    {!history.length && <p className="text-muted small p-3">No previous chats yet.</p>}
                    {history.map((sess) => (
                        <div key={sess.id} className="o_text_history_item">
                            <div className="o_text_history_meta">
                                <strong>{sess.name}</strong>
                                <span className="o_text_history_state">{sess.state}</span>
                            </div>
                            <div className="o_text_history_sub">
                                <span>{sess.agent_name}</span> · <span>{sess.message_count}</span> messages
                            </div>
                            <button className="btn btn-sm btn-link p-0" onClick={() => resumeSession(sess)}>
                                Resume
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="o_text_full_main">
                <div className="o_text_full_header">
                    <div className="o_text_full_header_inner o_text_full_agent_picker">
                        {text.agentThumbnailUrl ? (
                            <img className="o_text_agent_thumb" src={text.agentThumbnailUrl} alt="agent" />
                        ) : (
                            <div className="o_text_agent_thumb o_text_agent_thumb--placeholder">{agentInitial}</div>
                        )}
                        <select value={selectedAgentId ?? ""} onChange={onAgentChange}
                                disabled={isLive || isConnecting}>
                            {agents.map((agent) => (
                                <option key={agent.id} value={agent.id}>{agent.name}</option>
                            ))}
                        </select>
                        <span className="o_text_full_status">{statusLabel}</span>
                        {tokenBudgetLabel && (
                            <span className="o_text_token_budget"
                                  title="Tokens used since the last summary rollup.">
                                {tokenBudgetLabel}
                            </span>
                        )}
                    </div>
                    <div className="o_text_full_header_inner">
                        <button className="btn btn-light" onClick={toggleDark}
                                title={dark ? "Light theme" : "Dark theme"}>
                            <i className={dark ? "fa fa-sun-o" : "fa fa-moon-o"} />
                        </button>
                        <button className="btn btn-light" onClick={() => setShowHistory(!showHistory)}
                                title={showHistory ? "Hide history" : "Show history"}>
                            <i className="fa fa-history" />
                        </button>
                        {!isLive && !isConnecting && (
                            <button className="btn btn-primary" onClick={startSession}>
                                <i className="fa fa-comments" /> Start chat
                            </button>
                        )}
                        {!isLive && !isConnecting && lastResumableSession && (
                            <button className="btn btn-secondary"
                                    title={`Resume ${lastResumableSession.name}`}
                                    onClick={() => resumeSession(lastResumableSession)}>
                                <i className="fa fa-history" /> Resume last
                            </button>
                        )}
                        {(isLive || isConnecting) && (
                            <button className="btn btn-danger" onClick={endSession}>
                                <i className="fa fa-stop" /> End
                            </button>
                        )}
                    </div>
                </div>

                {st.errorMessage && (
                    <div className="o_text_error">
                        <strong>Error:</strong> {st.errorMessage}
                        <button className="btn btn-link p-0 float-end" onClick={dismissError} title="Dismiss">
                            <i className="fa fa-times" />
                        </button>
                    </div>
                )}

                <div className="o_text_full_transcript">
                    <Transcript messages={st.messages} isLive={isLive} thinking={st.thinking}
                                mode="text" agentThumbnailUrl={text.agentThumbnailUrl || false}
                                agentInitial={agentInitial} />
                </div>

                {isLive && (
                    <div className="o_text_input_bar">
                        {pendingFiles.length > 0 && (
                            <div className="o_text_pending_files">
                                {pendingFiles.map((f) => (
                                    <span key={f.xai_file_id} className="o_text_file_chip" title={f.filename}>
                                        <i className="fa fa-paperclip" /> <span>{f.filename}</span>
                                        <button className="o_text_chip_remove" title="Remove"
                                                onClick={() => removeFile(f.xai_file_id)}>
                                            <i className="fa fa-times" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        )}
                        <div className="o_text_input_row">
                            <button className="btn btn-light" onClick={pickFile}
                                    disabled={uploadingFile || st.compacting} title="Attach a file">
                                <i className={uploadingFile ? "fa fa-spinner fa-spin" : "fa fa-paperclip"} />
                            </button>
                            <input type="file" multiple style={{ display: "none" }}
                                   ref={fileInputRef} onChange={onFileSelected} />
                            <textarea rows={1}
                                      ref={textInputRef}
                                      placeholder={st.compacting ? "Compacting context…" : "Type a message…"}
                                      value={draftText}
                                      disabled={st.compacting || st.thinking}
                                      onChange={(ev) => setDraftText(ev.target.value)}
                                      onKeyDown={onTextKeydown} />
                            <button className="btn btn-primary"
                                    disabled={(!draftText.trim() && !pendingFiles.length) || st.compacting || st.thinking}
                                    onClick={sendMessage} title="Send">
                                <i className="fa fa-paper-plane" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
