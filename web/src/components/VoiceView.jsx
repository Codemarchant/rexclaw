import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useReactive } from "../lib/reactive";
import { voice, avatarRenderer } from "../services";
import { uiState, toggleImmersive, exitImmersive } from "../lib/ui_state";
import { EMOTIONS, EMOTION_GESTURE_MAP, GESTURES } from "../models/avatar_catalog";
import AvatarCanvas from "./AvatarCanvas.jsx";
import Transcript from "./Transcript.jsx";

// WASD + arrows → camera-relative movement axes for the manual walk toggle.
const MOVE_KEY_MAP = {
    KeyW: "fwd", ArrowUp: "fwd",
    KeyS: "back", ArrowDown: "back",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
};

export default function VoiceView({ active = true }) {
    const sv = useReactive(voice.state);
    const ui = useReactive(uiState);
    const [agents, setAgents] = useState([]);
    const [history, setHistory] = useState([]);
    const [selectedAgentId, setSelectedAgentId] = useState(null);
    const [showHistory, setShowHistory] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showTranscript, setShowTranscript] = useState(true);
    const [showControls, setShowControls] = useState(true);
    const [fullBody, setFullBody] = useState(false);
    const [moveMode, setMoveMode] = useState(false);
    const [currentEmotion, setCurrentEmotion] = useState("neutral");
    const [draftText, setDraftText] = useState("");
    const loadedAvatarId = useRef(null);
    const moveKeys = useRef(new Set());
    const textInputRef = useRef(null);

    const isLive = sv.status === "live";
    const isConnecting = sv.status === "connecting";

    const findAgent = useCallback(
        (id) => agents.find((a) => Number(a.id) === Number(id)),
        [agents],
    );

    // ---- data loading ------------------------------------------------------

    const loadHistory = useCallback(async () => {
        try {
            setHistory(await rpc("/api/voice/sessions", { limit: 30 }));
        } catch (e) {
            console.error("[voice] could not load history", e);
        }
    }, []);

    const refreshAgents = useCallback(async () => {
        try {
            const data = await rpc("/api/voice/agents", {});
            setAgents(data.agents || []);
        } catch (e) {
            console.error("[voice] could not refresh agents", e);
        }
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const data = await rpc("/api/voice/agents", {});
                const list = data.agents || [];
                setAgents(list);
                // Resolution: previous user pick → configured default → first.
                const candidates = [voice.preferredAgentId, data.default_agent_id, list[0]?.id];
                for (const id of candidates) {
                    if (id && list.some((a) => a.id === Number(id))) {
                        setSelectedAgentId(Number(id));
                        break;
                    }
                }
            } catch (e) {
                console.error("[voice] could not load agents", e);
            }
            loadHistory();
        })();
        return () => {
            // Drop walk mode + full-body framing when the view unmounts.
            avatarRenderer.setMoveMode?.(false);
            avatarRenderer.setFullBodyMode?.(false);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fetch the agent list whenever this tab becomes active so companions
    // created/edited/deleted in Settings show up without a reload. If the
    // selected agent vanished (deleted), fall back to the first available.
    useEffect(() => {
        if (!active) return;
        refreshAgents();
        loadHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    useEffect(() => {
        if (!agents.length) return;
        if (!agents.some((a) => Number(a.id) === Number(selectedAgentId))) {
            setSelectedAgentId(agents[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents]);

    // ---- avatar hydration (port of full_view._hydrateAvatar) ---------------

    const hydrateAvatar = useCallback((agentId) => {
        const agent = findAgent(agentId);
        const avatar = agent?.avatar;
        if (!avatar || !avatar.vrm_url) {
            avatarRenderer.configureFromAvatar(null);
            avatarRenderer.clearVRM?.();
            loadedAvatarId.current = null;
            voice.state.selectedOutfitId = 0;
            voice.state.backgroundPickedByUser = false;
            setCurrentEmotion("neutral");
            return;
        }
        avatarRenderer.configureFromAvatar(avatar);
        if (loadedAvatarId.current === avatar.id) return;
        loadedAvatarId.current = avatar.id;
        avatarRenderer.resetExpression?.();
        setCurrentEmotion("neutral");
        // Resolve the initial background with the SAME precedence the server
        // uses at session start: tagged default → latest Imagine → first.
        const bgs = avatar.backgrounds || [];
        const imagine = voice.state.latestImagineBackgroundByAgent?.[agentId]
            || agent?.latest_imagine_background || null;
        const resolved = bgs.find((b) => b.is_default) || imagine || bgs[0] || null;
        voice.state.activeBackground = resolved;
        voice.state.backgroundPickedByUser = false;
        avatarRenderer.setBackground?.(resolved);
        // Restore the user's last outfit pick if it belongs to this avatar.
        const wantId = Number(voice.state.selectedOutfitId || 0);
        const wantOutfit = (avatar.outfits || []).find((o) => Number(o.id) === wantId);
        const targetUrl = wantOutfit?.vrm_url || avatar.vrm_url;
        voice.state.selectedOutfitId = wantOutfit ? wantOutfit.id : 0;
        avatarRenderer.loadVRM(targetUrl).catch((e) => {
            console.error("[voice] avatar VRM load failed", e);
            loadedAvatarId.current = null;
        });
        if (avatar.vrma_idle_url) {
            avatarRenderer.loadVRMA(avatar.vrma_idle_url).catch(() => {});
        }
    }, [findAgent]);

    useEffect(() => {
        if (selectedAgentId && agents.length) hydrateAvatar(selectedAgentId);
    }, [selectedAgentId, agents, hydrateAvatar]);

    // ---- walk mode ----------------------------------------------------------

    const clearMoveInput = useCallback(() => {
        moveKeys.current.clear();
        avatarRenderer.setMoveInput?.(0, 0);
    }, []);

    const handleMoveKey = useCallback((ev, down) => {
        const t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        const dir = MOVE_KEY_MAP[ev.code];
        if (!dir) return;
        ev.preventDefault();
        if (down) moveKeys.current.add(dir);
        else moveKeys.current.delete(dir);
        avatarRenderer.setMoveInput?.(
            (moveKeys.current.has("right") ? 1 : 0) - (moveKeys.current.has("left") ? 1 : 0),
            (moveKeys.current.has("fwd") ? 1 : 0) - (moveKeys.current.has("back") ? 1 : 0),
        );
    }, []);

    const setMoveModeOn = useCallback((on) => {
        on = !!on;
        setMoveMode((prev) => {
            if (on === prev) return prev;
            avatarRenderer.setMoveMode?.(on);
            if (on && !fullBody) {
                setFullBody(true);
                avatarRenderer.setFullBodyMode?.(true);
            }
            if (!on) clearMoveInput();
            return on;
        });
    }, [fullBody, clearMoveInput]);

    useEffect(() => {
        if (!moveMode) return;
        const down = (ev) => handleMoveKey(ev, true);
        const up = (ev) => handleMoveKey(ev, false);
        const blur = () => clearMoveInput();
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        window.addEventListener("blur", blur);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
            window.removeEventListener("blur", blur);
            clearMoveInput();
        };
    }, [moveMode, handleMoveKey, clearMoveInput]);

    // Walk mode only exists inside a 3D scene — if the active background
    // stops being one, switch it off.
    const canMoveMode = sv.activeBackground?.type === "scene";
    useEffect(() => {
        if (moveMode && sv.activeBackground?.type !== "scene") {
            setMoveModeOn(false);
        }
    }, [sv.activeBackground, moveMode, setMoveModeOn]);

    // Auto-grow the draft textarea.
    useEffect(() => {
        const el = textInputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
    }, [draftText]);

    // ---- session actions ----------------------------------------------------

    const startSession = async () => {
        await voice.start(selectedAgentId);
        loadHistory();
    };

    const endSession = async () => {
        await voice.end("client");
        await Promise.all([loadHistory(), refreshAgents()]);
    };

    const resumeSession = async (sess) => {
        const ok = await voice.start(selectedAgentId, sess.id);
        if (ok === false) return;
        if (sess?.agent_id && agents.some((a) => a.id === sess.agent_id)) {
            setSelectedAgentId(sess.agent_id);
            voice.preferredAgentId = sess.agent_id;
        }
        setShowHistory(false);
        await Promise.all([loadHistory(), refreshAgents()]);
    };

    const lastResumableSession = useMemo(() => {
        const agentId = Number(selectedAgentId);
        if (!agentId) return null;
        const agent = findAgent(agentId);
        if (agent?.last_resumable_session) {
            return { ...agent.last_resumable_session, agent_id: agentId };
        }
        return (history || []).find(
            (s) => s.agent_id === agentId && (s.state === "ended" || s.state === "active"),
        ) || null;
    }, [selectedAgentId, findAgent, history]);

    const onAgentChange = (ev) => {
        const id = parseInt(ev.target.value, 10) || null;
        setSelectedAgentId(id);
        voice.preferredAgentId = id;
    };

    const toggleFullBody = () => {
        setFullBody((prev) => {
            avatarRenderer.setFullBodyMode?.(!prev);
            return !prev;
        });
    };

    const triggerEmotion = (emotionId) => {
        setCurrentEmotion(emotionId);
        avatarRenderer.setEmotion?.(emotionId, { explicit: false });
        const url = EMOTION_GESTURE_MAP[emotionId];
        if (url) avatarRenderer.playGesture?.(url);
    };

    const triggerGesture = (url, loop = false) => {
        avatarRenderer.playGesture?.(url, { loop });
    };

    const sendTextMessage = () => {
        if (voice.sendText(draftText)) setDraftText("");
    };

    const onTextKeydown = (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            sendTextMessage();
        }
    };

    const dismissError = () => {
        voice.state.errorMessage = null;
        if (voice.state.status === "error") voice.state.status = "idle";
    };

    // ---- derived view data --------------------------------------------------

    const currentAgent = findAgent(selectedAgentId);
    const currentOutfits = currentAgent?.avatar?.outfits || [];
    const customGestures = (currentAgent?.avatar?.custom_gestures || []).filter((g) => g.vrma_url);
    const currentBackgrounds = currentAgent?.avatar?.backgrounds || [];

    const currentImagineBackground = (() => {
        const active = sv.activeBackground;
        if (active && active.type === "imagine") return active;
        const inSession = sv.latestImagineBackgroundByAgent?.[selectedAgentId];
        if (inSession) return inSession;
        return currentAgent?.latest_imagine_background || null;
    })();

    const backgroundPickerEntries = (() => {
        const entries = [];
        const imagine = currentImagineBackground;
        if (imagine && !currentBackgrounds.length) {
            entries.push({ key: "default", label: "Default Background", bg: null });
        }
        if (imagine) {
            const label = imagine.name ? `Imagine — ${imagine.name}` : "Imagine background";
            entries.push({ key: "imagine", label, bg: imagine });
        }
        for (const bg of currentBackgrounds) {
            entries.push({ key: `bg-${bg.id}`, label: bg.name, bg });
        }
        return entries;
    })();

    const currentBackgroundKey = (() => {
        const active = sv.activeBackground;
        if (active && active.type === "imagine") return "imagine";
        if (active && active.id) return `bg-${active.id}`;
        const defaultBg = currentBackgrounds.find((b) => b.is_default) || currentBackgrounds[0];
        if (defaultBg) return `bg-${defaultBg.id}`;
        return backgroundPickerEntries.some((e) => e.key === "default") ? "default" : "";
    })();

    const onBackgroundChange = (ev) => {
        const key = ev?.target?.value;
        if (!key) return;
        const entry = backgroundPickerEntries.find((e) => e.key === key);
        if (!entry) return;
        avatarRenderer.setBackground?.(entry.bg);
        voice.state.activeBackground = entry.bg;
        voice.state.backgroundPickedByUser = true;
    };

    const onOutfitChange = (ev) => {
        const id = Number(ev.target.value);
        const avatar = currentAgent?.avatar;
        const outfit = (avatar?.outfits || []).find((o) => Number(o.id) === id);
        if (!outfit) return;
        voice.state.selectedOutfitId = id;
        avatarRenderer.setOutfit(outfit.vrm_url, avatar?.vrma_idle_url || null).catch((e) => {
            console.error("[voice] outfit load failed", e);
        });
    };

    const tokenBudgetLabel = sv.tokenLimit > 0
        ? `${(sv.tokenUsage || 0).toLocaleString()} / ${sv.tokenLimit.toLocaleString()}`
        : null;

    const statusLabel = (() => {
        if (sv.compacting) return "Compacting context…";
        switch (sv.status) {
            case "idle": return "Ready";
            case "connecting": return "Connecting…";
            case "live": return sv.muted ? "Muted (live)" : "Live";
            case "ending": return "Ending…";
            case "ended": return "Ended";
            case "error": return sv.errorMessage || "Error";
            default: return sv.status;
        }
    })();

    // ---- immersive mode ------------------------------------------------------
    // Hide ALL chrome (app header + canvas controls) for a pure full-screen
    // avatar, paired with the browser Fullscreen API so the browser chrome
    // goes too and native Esc exits. H toggles; Esc exits. The toggle itself
    // lives in lib/ui_state so the app header can drive it too.

    // H toggles; Esc exits when not in native fullscreen (when it IS, the
    // browser swallows Esc to exit fullscreen — the fullscreenchange handler
    // below catches that). Ignored while typing in the chat box.
    useEffect(() => {
        if (!active) return;
        const onKey = (ev) => {
            const t = ev.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if (ev.key === "h" || ev.key === "H") {
                ev.preventDefault();
                toggleImmersive();
            } else if (ev.key === "Escape" && uiState.immersive && !document.fullscreenElement) {
                exitImmersive();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active]);

    // Native fullscreen exit (Esc / F11 / OS) → drop immersive so the UI returns.
    useEffect(() => {
        const onFs = () => { if (!document.fullscreenElement && uiState.immersive) uiState.immersive = false; };
        document.addEventListener("fullscreenchange", onFs);
        return () => document.removeEventListener("fullscreenchange", onFs);
    }, []);

    // Leaving the Voice tab while immersive would full-screen another view —
    // exit cleanly.
    useEffect(() => {
        if (!active && uiState.immersive) exitImmersive();
    }, [active]);

    // ---- render --------------------------------------------------------------

    return (
        <div className={"o_voice_full_view" + (ui.immersive ? " o_voice_full_view--immersive" : "")}>
            {!ui.immersive && showHistory && (
                <div className="o_voice_full_history">
                    <div className="o_voice_full_history_header"><strong>History</strong></div>
                    {!history.length && <p className="text-muted small p-3">No previous sessions yet.</p>}
                    {history.map((sess) => (
                        <div key={sess.id} className="o_voice_history_item">
                            <div className="o_voice_history_meta">
                                <strong>{sess.name}</strong>
                                <span className="o_voice_history_state">{sess.state}</span>
                            </div>
                            <div className="o_voice_history_sub">
                                <span>{sess.agent_name}</span> · <span>{sess.message_count}</span> messages
                            </div>
                            {sess.summary && (
                                <div className="o_voice_history_summary" title={sess.summary}>{sess.summary}</div>
                            )}
                            <button className="btn btn-sm btn-link p-0" onClick={() => resumeSession(sess)}>
                                Resume
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="o_voice_full_avatar">
                <AvatarCanvas size="full" />
                {!ui.immersive && <div className="o_voice_full_topbar">
                    <div className="o_voice_full_topbar_row">
                        <button className="btn btn-light" onClick={() => setShowHistory(!showHistory)}
                                title={showHistory ? "Hide history" : "Show history"}>
                            <i className="fa fa-history" />
                        </button>
                        <button className={"btn btn-light" + (fullBody ? " active" : "")}
                                onClick={toggleFullBody}
                                title={fullBody ? "Switch to face view" : "Switch to full body (drag to rotate, scroll to zoom)"}>
                            <i className={fullBody ? "fa fa-user" : "fa fa-male"} />
                        </button>
                        {canMoveMode && (
                            <button className={"btn btn-light" + (moveMode ? " active" : "")}
                                    onClick={() => setMoveModeOn(!moveMode)}
                                    title={moveMode ? "Disable walk mode" : "Enable walk mode (WASD / arrow keys)"}>
                                <i className="fa fa-gamepad" />
                            </button>
                        )}
                        <button className={"btn btn-light" + (showSettings ? " active" : "")}
                                onClick={() => setShowSettings(!showSettings)}
                                title={showSettings ? "Hide manual triggers" : "Show manual emotion/gesture triggers"}>
                            <i className="fa fa-sliders" />
                        </button>
                        <button className={"btn btn-light" + (!showControls ? " active" : "")}
                                onClick={() => setShowControls(!showControls)}
                                title={showControls ? "Hide agent selector + call controls" : "Show agent selector + call controls"}>
                            <i className={showControls ? "fa fa-eye" : "fa fa-eye-slash"} />
                        </button>
                        <button className={"btn btn-light" + (!showTranscript ? " active" : "")}
                                onClick={() => setShowTranscript(!showTranscript)}
                                title={showTranscript ? "Hide transcript (full-width avatar)" : "Show transcript"}>
                            <i className={showTranscript ? "fa fa-comment" : "fa fa-comment-o"} />
                        </button>
                        <button className="btn btn-light" onClick={toggleImmersive}
                                title="Immersive view — hide all UI (H · Esc to exit)">
                            <i className="fa fa-expand" />
                        </button>
                    </div>
                    <div className="o_voice_full_topbar_row o_voice_full_topbar_row--meta">
                        <span className={
                            "o_voice_full_status"
                            + (isLive ? " is-live" : "")
                            + (isConnecting ? " is-connecting" : "")
                        }>
                            {statusLabel}
                        </span>
                        {tokenBudgetLabel && (
                            <span className="o_voice_token_budget"
                                  title="Tokens used since the last summary rollup, over the configured auto-compact threshold.">
                                {tokenBudgetLabel}
                            </span>
                        )}
                    </div>
                </div>}

                {!ui.immersive && showSettings && (
                    <div className="o_voice_full_settings">
                        <div className="o_voice_full_settings_section">
                            <strong>Emotions</strong>
                            <div className="o_voice_full_settings_grid">
                                {EMOTIONS.map((emo) => (
                                    <button key={emo.id}
                                            className={"btn btn-sm " + (currentEmotion === emo.id ? "btn-primary" : "btn-outline-light")}
                                            onClick={() => triggerEmotion(emo.id)}
                                            title={emo.label}>
                                        <i className={"fa " + emo.icon} />
                                        <span className="ms-1">{emo.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="o_voice_full_settings_section">
                            <strong>Gestures</strong>
                            <div className="o_voice_full_settings_grid">
                                {GESTURES.map((g) => (
                                    <button key={g.id} className="btn btn-sm btn-outline-light"
                                            onClick={() => triggerGesture(g.url)} title={g.label}>
                                        <i className={"fa " + g.icon} />
                                        <span className="ms-1">{g.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        {customGestures.length > 0 && (
                            <div className="o_voice_full_settings_section">
                                <strong>Custom Gestures</strong>
                                <div className="o_voice_full_settings_grid">
                                    {customGestures.map((g) => (
                                        <button key={g.id} className="btn btn-sm btn-outline-light"
                                                onClick={() => triggerGesture(g.vrma_url, g.loop)}
                                                title={g.loop ? `${g.name} (loops)` : g.name}>
                                            <i className={g.loop ? "fa fa-repeat" : "fa fa-star-o"} />
                                            <span className="ms-1">{g.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {!ui.immersive && showControls && (
                    <div className="o_voice_full_overlay">
                        <div className="o_voice_full_controls">
                            <select value={selectedAgentId ?? ""} onChange={onAgentChange}
                                    disabled={isLive || isConnecting}>
                                {agents.map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                        {agent.name} · {agent.voice}
                                    </option>
                                ))}
                            </select>
                            {currentOutfits.length > 1 && (
                                <select value={sv.selectedOutfitId ?? 0} onChange={onOutfitChange} title="Outfit">
                                    {currentOutfits.map((outfit) => (
                                        <option key={outfit.id} value={outfit.id}>{outfit.name}</option>
                                    ))}
                                </select>
                            )}
                            {backgroundPickerEntries.length > 1 && (
                                <select value={currentBackgroundKey} onChange={onBackgroundChange} title="Background">
                                    {backgroundPickerEntries.map((entry) => (
                                        <option key={entry.key} value={entry.key}>{entry.label}</option>
                                    ))}
                                </select>
                            )}
                            <div className="o_voice_full_controls_buttons">
                                {!isLive && !isConnecting && (
                                    <button className="btn btn-primary btn-lg" onClick={startSession}>
                                        <i className="fa fa-microphone" /> Start
                                    </button>
                                )}
                                {!isLive && !isConnecting && lastResumableSession && (
                                    <button className="btn btn-secondary btn-lg"
                                            title={`Resume ${lastResumableSession.name}`}
                                            onClick={() => resumeSession(lastResumableSession)}>
                                        <i className="fa fa-history" /> Resume last
                                    </button>
                                )}
                                {isLive && (
                                    <button className={"btn btn-lg " + (sv.muted ? "btn-warning" : "btn-secondary")}
                                            onClick={() => voice.setMuted(!sv.muted)}>
                                        <i className={sv.muted ? "fa fa-microphone-slash" : "fa fa-microphone"}
                                           title={sv.muted ? "Unmute" : "Mute"} />
                                    </button>
                                )}
                                {(isLive || isConnecting) && (
                                    <button className="btn btn-lg btn-danger" onClick={endSession}>
                                        <i className="fa fa-stop" /> End
                                    </button>
                                )}
                            </div>
                        </div>
                        {sv.errorMessage && (
                            <div className="o_voice_error">
                                <strong>Error:</strong> {sv.errorMessage}
                                <button className="btn btn-link p-0 float-end" onClick={dismissError} title="Dismiss">
                                    <i className="fa fa-times" />
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {!ui.immersive && showTranscript && (
                <div className="o_voice_full_transcript">
                    <Transcript messages={sv.messages} isLive={isLive}
                                thinking={sv.thinking} truncated={sv.transcriptTruncated} />
                    {isLive && (
                        <div className="o_voice_text_input">
                            <textarea rows={1}
                                      ref={textInputRef}
                                      placeholder={sv.compacting ? "Compacting context…" : "Type a message…"}
                                      value={draftText}
                                      disabled={sv.compacting}
                                      onChange={(ev) => setDraftText(ev.target.value)}
                                      onKeyDown={onTextKeydown} />
                            <button className="btn btn-sm btn-primary"
                                    disabled={!draftText.trim() || sv.compacting}
                                    onClick={sendTextMessage}
                                    title="Send">
                                <i className="fa fa-paper-plane" />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
