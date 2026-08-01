import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { voice, avatarRenderer, notification } from "../services";
import { uiState, toggleImmersive, exitImmersive } from "../lib/ui_state";
import { EMOTIONS, EMOTION_GESTURE_MAP, GESTURES } from "../models/avatar_catalog";
import { VRManager } from "../vr/vr_manager";
import AvatarCanvas from "./AvatarCanvas.jsx";
import Transcript from "./Transcript.jsx";

/** Downscale a user-picked image file to a data URL (long edge ≤ maxSize).
 *  createImageBitmap honours EXIF orientation, so phone photos come out
 *  upright. PNG keeps transparency; everything else re-encodes as JPEG. */
async function downscaleImageFile(file, maxSize = 2048) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return file.type === "image/png"
        ? canvas.toDataURL("image/png")
        : canvas.toDataURL("image/jpeg", 0.9);
}

// WASD + arrows → camera-relative movement axes for the manual walk toggle.
const MOVE_KEY_MAP = {
    KeyW: "fwd", ArrowUp: "fwd",
    KeyS: "back", ArrowDown: "back",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
};

// Prefer an AR session: it supports passthrough AND can occlude it with a
// skybox, so the in-headset A/X button toggles AR↔VR with no session
// restart. Falls back to immersive-vr (skybox only) if AR is unsupported
// (handled in renderer.enterXR).
const XR_MODE = "immersive-ar";

/** Headset browsers (e.g. Pico) often don't repaint already-laid-out
 *  icon-font glyphs when the FontAwesome webfont finishes loading, so the
 *  topbar icons stay blank until an interaction forces a style recalc.
 *  Force a one-frame compositing repaint of the view once fonts are ready
 *  (and again after an explicit FA load in case `ready` resolved early). */
function ensureIconsPaint(rootRef) {
    const repaint = () => {
        const el = rootRef?.current;
        if (!el) return;
        el.style.transform = "translateZ(0)";
        void el.offsetHeight;  // force reflow
        requestAnimationFrame(() => {
            if (rootRef?.current) rootRef.current.style.transform = "";
        });
    };
    const fonts = document.fonts;
    if (fonts?.ready) {
        fonts.ready.then(repaint).catch(() => {});
        try { fonts.load("normal 16px FontAwesome").then(repaint).catch(() => {}); } catch (e) { /* non-fatal */ }
    } else {
        setTimeout(repaint, 300);
    }
}

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
    const [xrSupported, setXrSupported] = useState(false);   // headset/browser can present immersive VR
    const [mrSupported, setMrSupported] = useState(false);   // immersive-ar (passthrough MR) also available
    const [desktopVR, setDesktopVR] = useState(false);       // Electron shell: OpenXR runtime + browser for handoff
    const [vrPrompt, setVrPrompt] = useState(false);         // #vr auto-enter blocked by activation → one-click overlay
    const [addAgentId, setAddAgentId] = useState("");        // group-call "Add agent" dropdown selection
    const loadedAvatarId = useRef(null);
    const moveKeys = useRef(new Set());
    const textInputRef = useRef(null);
    const rootRef = useRef(null);
    const vrManagerRef = useRef(null);
    const vrGesturesRef = useRef(() => []);

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
        ensureIconsPaint(rootRef);
        // Probe WebXR support (async, headset/browser dependent) so the
        // Enter VR button only appears where an immersive session is possible.
        avatarRenderer.checkXRSupport?.()
            .then((ok) => setXrSupported(!!ok))
            .catch(() => {});
        avatarRenderer.checkARSupport?.()
            .then((ok) => setMrSupported(!!ok))
            .catch(() => {});
        // Electron shell (WebXR compiled out): offer the browser handoff
        // instead, but only when the machine can actually present VR.
        window.rexclawDesktop?.vrAvailable?.()
            .then((ok) => setDesktopVR(!!ok))
            .catch(() => {});
        // VR controllers/push-to-talk/haptics — attaches to the renderer's
        // XR lifecycle; dormant until enterVR() starts a session.
        vrManagerRef.current = new VRManager(avatarRenderer, {
            voice,
            getGestures: () => vrGesturesRef.current(),
        });
        vrManagerRef.current.attach();
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
            // Tear down VR wiring (and end any live session) before the rest.
            vrManagerRef.current?.detach();
            vrManagerRef.current = null;
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

    // Resume handoff from the Sessions tab: pick up the pending request once
    // this view is active. voice.start refuses politely (toast) if a session
    // is already live.
    useEffect(() => {
        const pr = uiState.pendingResume;
        if (!active || !pr || pr.mode === "text") return;
        uiState.pendingResume = null;
        (async () => {
            const ok = await voice.start(pr.agentId, pr.sessionId);
            if (ok !== false && pr.agentId) {
                setSelectedAgentId(pr.agentId);
                voice.preferredAgentId = pr.agentId;
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
        // uses at session start: tagged default → newest Imagine (still and
        // animated are parallel "latest" tracks; most recent wins) → first.
        const bgs = avatar.backgrounds || [];
        const imagineStill = voice.state.latestImagineBackgroundByAgent?.[agentId]
            || agent?.latest_imagine_background || null;
        const imagineVideo = voice.state.latestImagineVideoBackgroundByAgent?.[agentId]
            || agent?.latest_imagine_video_background || null;
        const imagine = [imagineStill, imagineVideo].filter(Boolean)
            .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
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

    /** Point walk-mode input at character `idx` (0 = the main avatar,
     *  1… = call peers in join order) and toast who's being controlled. */
    const selectWalkActor = useCallback((idx) => {
        let ok;
        let name;
        if (idx === 0) {
            ok = avatarRenderer.setMoveActor?.("base");
            name = voice.state.agentName || _t("Main avatar");
        } else {
            const peer = (voice.state.peers || [])[idx - 1];
            if (!peer) return;  // no such participant — ignore the key
            ok = avatarRenderer.setMoveActor?.(peer.connId);
            name = peer.agentName || _t("Companion");
        }
        if (ok) {
            notification.add(_t("Walk control: %s", name), { type: "info" });
        }
    }, []);

    const handleMoveKey = useCallback((ev, down) => {
        const t = ev.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        // Number keys select WHICH character the movement keys drive:
        // 1 = the main avatar, 2… = the agents added to the call, in join
        // order. Only meaningful in a group call — solo calls have nothing
        // else to steer.
        if (/^Digit[1-9]$/.test(ev.code) && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
            if (!down) return;
            ev.preventDefault();
            selectWalkActor(Number(ev.code.slice(5)) - 1);
            return;
        }
        const dir = MOVE_KEY_MAP[ev.code];
        if (!dir) return;
        ev.preventDefault();
        if (down) moveKeys.current.add(dir);
        else moveKeys.current.delete(dir);
        avatarRenderer.setMoveInput?.(
            (moveKeys.current.has("right") ? 1 : 0) - (moveKeys.current.has("left") ? 1 : 0),
            (moveKeys.current.has("fwd") ? 1 : 0) - (moveKeys.current.has("back") ? 1 : 0),
        );
    }, [selectWalkActor]);

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

    /** Manually fire a custom gesture record from the settings panel. Combos
     *  need their whole payload (partner URLs + placement config), so this
     *  takes the record rather than a bare URL — routing mirrors the
     *  play_gesture tool dispatcher. */
    const triggerCustomGesture = (g) => {
        if (g.type === "combo" && g.partner_vrm_url && g.partner_vrma_url) {
            avatarRenderer.playComboGesture?.(g);
            return;
        }
        avatarRenderer.playGesture?.(g.vrma_url, { loop: !!g.loop });
    };

    /** Enter an immersive VR session, re-staging the already-loaded avatar +
     *  live conversation in the headset. Must run from this click (WebXR
     *  requires a user gesture). The renderer owns the session lifecycle,
     *  dolly rig, and render-loop switch; we just kick it off and surface
     *  failures. Exiting VR is done from the headset and restores the desktop
     *  framing automatically (renderer _onXRSessionEnd). */
    /** VR has no reach into the flat-view call controls, so entering it
     *  with no call running strands the user in a mute scene. Kick the
     *  session off alongside the immersive transition: resume the agent's
     *  last conversation when there is one, else start fresh. Deliberately
     *  not awaited by callers — requestSession must spend the click's
     *  transient activation in the same tick. */
    const startCallIfIdle = () => {
        const st = voice.state.status;
        if (st === "live" || st === "connecting") return;
        (lastResumableSession ? resumeSession(lastResumableSession) : startSession())
            .catch((e) => console.error("[voice] VR call auto-start failed", e));
    };

    const enterVR = async () => {
        startCallIfIdle();
        try {
            await avatarRenderer.enterXR(XR_MODE);
        } catch (e) {
            console.error("[voice] enter VR failed", e);
            notification.add(_t("Could not start VR: %s", e?.message || e), { type: "danger" });
        }
    };

    // The auto-enter below fires up to 15 s after mount — go through a ref
    // so it sees the current session/agent state, not the first render's.
    const startCallIfIdleRef = useRef(startCallIfIdle);
    startCallIfIdleRef.current = startCallIfIdle;

    // Desktop VR handoff lands here with #vr in the URL: try to enter the
    // immersive session without another click. Chrome enforces user
    // activation for requestSession (the no-gesture switch no longer covers
    // WebXR), so when the silent attempt is rejected we fall back to a
    // single-click overlay rather than an error toast. Waits for the VRM
    // first — session-start placement runs once, on the first XR frame, and
    // needs a body to stand the viewer in front of.
    useEffect(() => {
        if (!xrSupported || !/vr/.test(window.location.hash)) return;
        // Drop the hash so a manual reload of the window behaves normally.
        window.history.replaceState(null, "", window.location.pathname);
        let tries = 0;
        const timer = setInterval(() => {
            if (avatarRenderer.vrm || ++tries > 50) {   // ≤15 s wait
                clearInterval(timer);
                startCallIfIdleRef.current();   // talking works either way
                avatarRenderer.enterXR(XR_MODE).catch(() => setVrPrompt(true));
            }
        }, 300);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [xrSupported]);

    // ---- group calls (multi-agent) -----------------------------------------

    const callPeers = sv.peers || [];

    /** Agents that can still be added: everyone except the primary agent
     *  and the peers already in the call. */
    const availableCallAgents = useMemo(() => {
        const taken = new Set([Number(sv.agentId) || Number(selectedAgentId)]);
        for (const p of callPeers) taken.add(Number(p.agentId));
        return agents.filter((a) => !taken.has(Number(a.id)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents, selectedAgentId, sv.agentId, sv.peers]);

    const addAgentToCall = async () => {
        const id = Number(addAgentId);
        if (!id) return;
        const agent = findAgent(id);
        const ok = await voice.addAgentToCall(id, agent?.name || "");
        if (ok) setAddAgentId("");
    };

    // Group calls need the wide shot: enter full-body view when a second
    // character joins — whether added from the UI or invited by an agent via
    // the add_agent_to_call tool. Fires on count changes only, so manually
    // leaving full-body afterwards isn't fought.
    useEffect(() => {
        if (callPeers.length > 0 && !fullBody) {
            setFullBody(true);
            avatarRenderer.setFullBodyMode?.(true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [callPeers.length]);

    const removeCallPeer = async (connId) => {
        await voice.removeAgentFromCall(connId);
    };

    const sendTextMessage = () => {
        const text = draftText.trim();
        const images = pendingImages;
        const docs = pendingDocs;
        if (!text && !images.length && !docs.length) return;
        if (images.length || docs.length) {
            // Hidden note first (no response prompt), THEN the visible turn —
            // the model reads both and reacts once. With no typed text the
            // service default decides (react now solo; inform-next-turn in
            // group calls, where an unprompted reaction would steal the floor).
            voice.sendContextEvent(attachmentNote(images, docs), {
                ...(text ? { promptResponse: false } : {}),
                minIntervalMs: 0,
            });
            setPendingImages([]);
            setPendingDocs([]);
        }
        if (text && voice.sendText(text)) setDraftText("");
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

    // Unified gesture list for the VR panel's Gestures tab: the built-in pack
    // plus the current agent's custom VRMA gestures. Shape: {id,label,url,loop}
    // — combo customs additionally carry their full payload record in `combo`
    // so vr_manager can route them to the two-character player.
    useEffect(() => {
        vrGesturesRef.current = () => {
            const builtin = GESTURES.map((g) => ({ id: g.id, label: g.label, url: g.url, loop: !!g.loop }));
            const custom = customGestures.map((g) => ({
                id: "c" + g.id, label: g.name, url: g.vrma_url, loop: !!g.loop,
                combo: g.type === "combo" ? g : null,
            }));
            return [...builtin, ...custom];
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentAgent]);

    const currentImagineBackground = (() => {
        const active = sv.activeBackground;
        if (active && active.type === "imagine") return active;
        const inSession = sv.latestImagineBackgroundByAgent?.[selectedAgentId];
        if (inSession) return inSession;
        return currentAgent?.latest_imagine_background || null;
    })();

    // Parallel slot for the newest ANIMATED Imagine background — still and
    // animated coexist in the picker as separate entries.
    const currentImagineVideoBackground = (() => {
        const active = sv.activeBackground;
        if (active && active.type === "imagine_video") return active;
        const inSession = sv.latestImagineVideoBackgroundByAgent?.[selectedAgentId];
        if (inSession) return inSession;
        return currentAgent?.latest_imagine_video_background || null;
    })();

    const backgroundPickerEntries = (() => {
        const entries = [];
        const imagine = currentImagineBackground;
        const imagineVideo = currentImagineVideoBackground;
        if ((imagine || imagineVideo) && !currentBackgrounds.length) {
            entries.push({ key: "default", label: _t("Default Background"), bg: null });
        }
        if (imagine) {
            const label = imagine.name ? `Imagine — ${imagine.name}` : _t("Imagine background");
            entries.push({ key: "imagine", label, bg: imagine });
        }
        if (imagineVideo) {
            const label = imagineVideo.name
                ? `Imagine ▶ ${imagineVideo.name}` : _t("Animated background");
            entries.push({ key: "imagine-video", label, bg: imagineVideo });
        }
        for (const bg of currentBackgrounds) {
            entries.push({ key: `bg-${bg.id}`, label: bg.name, bg });
        }
        return entries;
    })();

    const currentBackgroundKey = (() => {
        const active = sv.activeBackground;
        if (active && active.type === "imagine") return "imagine";
        if (active && active.type === "imagine_video") return "imagine-video";
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

    // Voice-mode attachments: picked files upload eagerly and queue as
    // chips on the message box; SEND delivers one hidden context note for
    // the whole batch alongside the typed text, so the model reacts once —
    // to message + attachments together — instead of after every upload.
    // Images downscale to a data URI and land in the Imagine library
    // (create_video/create_image can USE them); any other file type (PDF,
    // CSV, …) streams to xAI /v1/files and the note carries its
    // xai_file_id so the model can hand it to delegate_task for analysis.
    // The voice model itself can't see or read either kind.
    const imageInputRef = useRef(null);
    const [pendingImages, setPendingImages] = useState([]);
    const [pendingDocs, setPendingDocs] = useState([]);
    const [uploadingImages, setUploadingImages] = useState(false);
    const onFilesChosen = async (ev) => {
        const files = [...(ev.target.files || [])].slice(0, 6);
        ev.target.value = "";
        if (!files.length || !sv.sessionId) return;
        setUploadingImages(true);
        try {
            for (const file of files) {
                if ((file.type || "").startsWith("image/")) {
                    const dataUrl = await downscaleImageFile(file);
                    const result = await rpc(`/api/voice/session/${sv.sessionId}/upload_image`, {
                        image_data_url: dataUrl,
                        name: file.name,
                    });
                    setPendingImages((prev) => [...prev, result]);
                } else {
                    if (file.size > 48 * 1024 * 1024) {
                        throw new Error(_t('"%s" is too large (max 48 MB).', file.name));
                    }
                    const fd = new FormData();
                    fd.append("file", file, file.name);
                    const resp = await fetch(`/api/voice/session/${sv.sessionId}/upload_file`, {
                        method: "POST",
                        body: fd,
                        credentials: "same-origin",
                    });
                    if (!resp.ok) {
                        const errBody = await resp.json().catch(() => ({}));
                        throw new Error(errBody.error || `Upload failed (${resp.status})`);
                    }
                    const meta = await resp.json();
                    setPendingDocs((prev) => [...prev, {
                        xai_file_id: meta.file_id,
                        name: meta.filename || file.name,
                    }]);
                }
            }
        } catch (e) {
            notification.add(_t("Upload failed: %s", e?.data?.message || e?.message || e), { type: "danger" });
        } finally {
            setUploadingImages(false);
        }
    };
    const removePendingImage = (id) => {
        // Chip removal only unqueues it from THIS message — an image upload
        // already lives in the Imagine library, which is harmless.
        setPendingImages((prev) => prev.filter((p) => p.imagine_image_id !== id));
    };
    const removePendingDoc = (fileId) => {
        setPendingDocs((prev) => prev.filter((p) => p.xai_file_id !== fileId));
    };
    const attachmentNote = (images, docs) => {
        const parts = [];
        if (images.length) {
            const listing = images
                .map((p) => `"${p.name}" (image_url=${p.image_url}, imagine_image_id=${p.imagine_image_id})`)
                .join("; ");
            parts.push(
                `The user attached ${images.length} image(s): ${listing}. `
                + `You cannot see them (voice is audio-only), but you can use `
                + `them — call delegate_task with an imagine_image_id in files `
                + `to have their content described/analyzed, or pass an `
                + `image_url to create_video as source_image (animate that `
                + `exact image) or reference_images (feature its people/objects `
                + `in a new clip, up to 3).`
            );
        }
        if (docs.length) {
            const listing = docs
                .map((p) => `"${p.name}" (xai_file_id=${p.xai_file_id})`)
                .join("; ");
            parts.push(
                `The user attached ${docs.length} file(s): ${listing}. You `
                + `cannot read them yourself — call delegate_task with the `
                + `xai_file_id value(s) in files to read/analyze their content.`
            );
        }
        return `[System] ${parts.join(" ")}`;
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
        if (sv.compacting) return _t("Compacting context…");
        switch (sv.status) {
            case "idle": return _t("Ready");
            case "connecting": return _t("Connecting…");
            case "live": return sv.muted ? _t("Muted (live)") : _t("Live");
            case "ending": return _t("Ending…");
            case "ended": return _t("Ended");
            case "error": return sv.errorMessage || _t("Error");
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
        <div ref={rootRef}
             className={"o_voice_full_view" + (ui.immersive ? " o_voice_full_view--immersive" : "")}>
            {vrPrompt && (
                <div style={{ position: "fixed", inset: 0, zIndex: 2000,
                              background: "rgba(15, 23, 42, 0.75)", display: "flex",
                              alignItems: "center", justifyContent: "center" }}>
                    <button className="btn btn-primary btn-lg"
                            onClick={() => { setVrPrompt(false); enterVR(); }}>
                        <i className="fa fa-cube" /> {_t("Enter VR")}
                    </button>
                </div>
            )}
            {!ui.immersive && showHistory && (
                <div className="o_voice_full_history">
                    <div className="o_voice_full_history_header"><strong>{_t("History")}</strong></div>
                    {!history.length && <p className="text-muted small p-3">{_t("No previous sessions yet.")}</p>}
                    {history.map((sess) => (
                        <div key={sess.id} className="o_voice_history_item">
                            <div className="o_voice_history_meta">
                                <strong>{sess.name}</strong>
                                <span className="o_voice_history_state">{sess.state}</span>
                            </div>
                            <div className="o_voice_history_sub">
                                <span>{sess.agent_name}</span> · <span>{sess.message_count}</span> {_t("messages")}
                            </div>
                            {sess.summary && (
                                <div className="o_voice_history_summary" title={sess.summary}>{sess.summary}</div>
                            )}
                            <button className="btn btn-sm btn-link p-0" onClick={() => resumeSession(sess)}>
                                {_t("Resume")}
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
                                title={showHistory ? _t("Hide history") : _t("Show history")}>
                            <i className="fa fa-history" />
                        </button>
                        {xrSupported ? (
                            <button className="btn btn-light" onClick={enterVR}
                                    title={mrSupported
                                        ? _t("Enter MR/VR — passthrough mixed reality (toggle Virtual/Passthrough on the in-headset panel)")
                                        : _t("Enter VR — stand with your companion in a headset (passthrough MR unavailable on this browser)")}>
                                <i className="fa fa-cube" />
                            </button>
                        ) : (desktopVR && (
                            // Electron shell: WebXR is compiled out of Electron, so
                            // hand off to a real Chromium browser in --app mode
                            // (same server, same session) where it works.
                            <button className="btn btn-light"
                                    onClick={() => window.rexclawDesktop.openVR()}
                                    title={_t("Enter VR — opens this companion in a VR-capable browser window")}>
                                <i className="fa fa-cube" />
                            </button>
                        ))}
                        <button className={"btn btn-light" + (fullBody ? " active" : "")}
                                onClick={toggleFullBody}
                                title={fullBody ? _t("Switch to face view") : _t("Switch to full body (drag to rotate, scroll to zoom)")}>
                            <i className={fullBody ? "fa fa-user" : "fa fa-male"} />
                        </button>
                        {canMoveMode && (
                            <button className={"btn btn-light" + (moveMode ? " active" : "")}
                                    onClick={() => setMoveModeOn(!moveMode)}
                                    title={moveMode ? _t("Disable walk mode") : _t("Enable walk mode (WASD / arrow keys — number keys pick which character to move in a group call)")}>
                                <i className="fa fa-gamepad" />
                            </button>
                        )}
                        <button className={"btn btn-light" + (showSettings ? " active" : "")}
                                onClick={() => setShowSettings(!showSettings)}
                                title={showSettings ? _t("Hide manual triggers") : _t("Show manual emotion/gesture triggers")}>
                            <i className="fa fa-sliders" />
                        </button>
                        <button className={"btn btn-light" + (!showControls ? " active" : "")}
                                onClick={() => setShowControls(!showControls)}
                                title={showControls ? _t("Hide agent selector + call controls") : _t("Show agent selector + call controls")}>
                            <i className={showControls ? "fa fa-eye" : "fa fa-eye-slash"} />
                        </button>
                        <button className={"btn btn-light" + (!showTranscript ? " active" : "")}
                                onClick={() => setShowTranscript(!showTranscript)}
                                title={showTranscript ? _t("Hide transcript (full-width avatar)") : _t("Show transcript")}>
                            <i className={showTranscript ? "fa fa-comment" : "fa fa-comment-o"} />
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
                                  title={_t("Tokens used since the last summary rollup, over the configured auto-compact threshold.")}>
                                {tokenBudgetLabel}
                            </span>
                        )}
                    </div>
                </div>}

                {!ui.immersive && showSettings && (
                    <div className="o_voice_full_settings">
                        <div className="o_voice_full_settings_section">
                            <strong>{_t("Emotions")}</strong>
                            <div className="o_voice_full_settings_grid">
                                {EMOTIONS.map((emo) => (
                                    <button key={emo.id}
                                            className={"btn btn-sm " + (currentEmotion === emo.id ? "btn-primary" : "btn-outline-light")}
                                            onClick={() => triggerEmotion(emo.id)}
                                            title={_t(emo.label)}>
                                        <i className={"fa " + emo.icon} />
                                        <span className="ms-1">{_t(emo.label)}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="o_voice_full_settings_section">
                            <strong>{_t("Gestures")}</strong>
                            <div className="o_voice_full_settings_grid">
                                {GESTURES.map((g) => (
                                    <button key={g.id} className="btn btn-sm btn-outline-light"
                                            onClick={() => triggerGesture(g.url, !!g.loop)}
                                            title={_t(g.label) + (g.loop ? " " + _t("(loops)") : "")}>
                                        <i className={"fa " + g.icon} />
                                        <span className="ms-1">{_t(g.label)}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                        {customGestures.length > 0 && (
                            <div className="o_voice_full_settings_section">
                                <strong>{_t("Custom Gestures")}</strong>
                                <div className="o_voice_full_settings_grid">
                                    {customGestures.map((g) => (
                                        <button key={g.id} className="btn btn-sm btn-outline-light"
                                                onClick={() => triggerCustomGesture(g)}
                                                title={(g.type === "combo" ? `${g.name} ${_t("(combo)")}` : g.name) + (g.loop ? " " + _t("(loops)") : "")}>
                                            <i className={g.type === "combo" ? "fa fa-users" : (g.loop ? "fa fa-repeat" : "fa fa-star-o")} />
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
                                        {agent.name} · {agent.voice_label || agent.voice}
                                    </option>
                                ))}
                            </select>
                            {currentOutfits.length > 1 && (
                                <select value={sv.selectedOutfitId ?? 0} onChange={onOutfitChange} title={_t("Outfit")}>
                                    {currentOutfits.map((outfit) => (
                                        <option key={outfit.id} value={outfit.id}>{outfit.name}</option>
                                    ))}
                                </select>
                            )}
                            {backgroundPickerEntries.length > 1 && (
                                <select value={currentBackgroundKey} onChange={onBackgroundChange} title={_t("Background")}>
                                    {backgroundPickerEntries.map((entry) => (
                                        <option key={entry.key} value={entry.key}>{entry.label}</option>
                                    ))}
                                </select>
                            )}
                            <div className="o_voice_full_controls_buttons">
                                {!isLive && !isConnecting && (
                                    <button className="btn btn-primary btn-lg" onClick={startSession}>
                                        <i className="fa fa-microphone" /> {_t("Start")}
                                    </button>
                                )}
                                {!isLive && !isConnecting && lastResumableSession && (
                                    <button className="btn btn-secondary btn-lg"
                                            title={_t("Resume %s", lastResumableSession.name)}
                                            onClick={() => resumeSession(lastResumableSession)}>
                                        <i className="fa fa-history" /> {_t("Resume last")}
                                    </button>
                                )}
                                {isLive && (
                                    <button className={"btn btn-lg " + (sv.muted ? "btn-warning" : "btn-secondary")}
                                            onClick={() => voice.setMuted(!sv.muted)}>
                                        <i className={sv.muted ? "fa fa-microphone-slash" : "fa fa-microphone"}
                                           title={sv.muted ? _t("Unmute") : _t("Mute")} />
                                    </button>
                                )}
                                {(isLive || isConnecting) && (
                                    <button className="btn btn-lg btn-danger" onClick={endSession}>
                                        <i className="fa fa-stop" /> {_t("End")}
                                    </button>
                                )}
                            </div>
                            {/* Group call: agents currently in the call + "add another" picker.
                                Only shown while live — adding an agent opens a second realtime
                                connection and stands its avatar beside the current one. */}
                            {isLive && (
                                <div className="o_voice_call_agents">
                                    {callPeers.map((peer) => (
                                        <span key={peer.connId} className="o_voice_call_peer_chip"
                                              title={_t("%s is in this call", peer.agentName || _t("Agent"))}>
                                            <i className="fa fa-user" />
                                            <span>{peer.agentName || _t("Agent")}</span>
                                            <button className="btn btn-link p-0 ms-1"
                                                    onClick={() => removeCallPeer(peer.connId)}
                                                    title={_t("Remove from call")}>
                                                <i className="fa fa-times" />
                                            </button>
                                        </span>
                                    ))}
                                    {availableCallAgents.length > 0 && (
                                        <>
                                            <select value={addAgentId}
                                                    onChange={(ev) => setAddAgentId(ev.target.value)}
                                                    title={_t("Add another agent to the call")}>
                                                <option value="">{_t("Add agent to call…")}</option>
                                                {availableCallAgents.map((agent) => (
                                                    <option key={agent.id} value={agent.id}>
                                                        {agent.name} · {agent.voice_label || agent.voice}
                                                    </option>
                                                ))}
                                            </select>
                                            <button className="btn btn-sm btn-secondary"
                                                    disabled={!addAgentId}
                                                    onClick={addAgentToCall}
                                                    title={_t("Add the selected agent to this call")}>
                                                <i className="fa fa-user-plus" /> {_t("Add")}
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                        {sv.errorMessage && (
                            <div className="o_voice_error">
                                <strong>{_t("Error:")}</strong> {sv.errorMessage}
                                <button className="btn btn-link p-0 float-end" onClick={dismissError} title={_t("Dismiss")}>
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
                    {isLive && (pendingImages.length > 0 || pendingDocs.length > 0) && (
                        <div className="o_voice_text_attachments">
                            {pendingImages.map((p) => (
                                <span key={p.imagine_image_id} className="o_voice_text_attach_chip" title={p.name}>
                                    <img src={p.image_url} alt={p.name} />
                                    <span className="o_voice_text_attach_name">{p.name}</span>
                                    <button className="btn btn-link p-0"
                                            onClick={() => removePendingImage(p.imagine_image_id)}
                                            title={_t("Remove")}>
                                        <i className="fa fa-times" />
                                    </button>
                                </span>
                            ))}
                            {pendingDocs.map((d) => (
                                <span key={d.xai_file_id} className="o_voice_text_attach_chip" title={d.name}>
                                    <i className="fa fa-file-o" />
                                    <span className="o_voice_text_attach_name">{d.name}</span>
                                    <button className="btn btn-link p-0"
                                            onClick={() => removePendingDoc(d.xai_file_id)}
                                            title={_t("Remove")}>
                                        <i className="fa fa-times" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                    {isLive && (
                        <div className="o_voice_text_input">
                            <button className="btn btn-sm btn-secondary"
                                    disabled={sv.compacting || uploadingImages}
                                    onClick={() => imageInputRef.current?.click()}
                                    title={_t("Attach files")}>
                                <i className={uploadingImages ? "fa fa-spinner fa-spin" : "fa fa-paperclip"} />
                            </button>
                            <input ref={imageInputRef} type="file" multiple
                                   style={{ display: "none" }} onChange={onFilesChosen} />
                            <textarea rows={1}
                                      ref={textInputRef}
                                      placeholder={sv.compacting ? _t("Compacting context…") : _t("Type a message…")}
                                      value={draftText}
                                      disabled={sv.compacting}
                                      onChange={(ev) => setDraftText(ev.target.value)}
                                      onKeyDown={onTextKeydown} />
                            <button className="btn btn-sm btn-primary"
                                    disabled={(!draftText.trim() && !pendingImages.length && !pendingDocs.length) || sv.compacting}
                                    onClick={sendTextMessage}
                                    title={_t("Send")}>
                                <i className="fa fa-paper-plane" />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
