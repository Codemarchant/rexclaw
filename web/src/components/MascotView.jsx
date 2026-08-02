import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { voice, avatarRenderer } from "../services";
import { screenCapture } from "../lib/screen_capture";
import { storedOutfit } from "../lib/outfit_pref";
import AvatarCanvas from "./AvatarCanvas.jsx";

// Window sizes the ⤢ button cycles through (bottom-right corner anchored by
// the shell). Portrait 2:3-ish — a standing character's natural frame. The
// old 280×420 step is gone (it clipped the controls island); the two big
// steps mainly serve full-body view, and the shell clamps them to the
// screen's work area on smaller displays. Scroll on the avatar still gives
// fine-grained sizing between the presets.
const SIZES = [
    { width: 380, height: 560 },
    { width: 480, height: 700 },
    { width: 620, height: 900 },
    { width: 760, height: 1100 },
];

/** Desktop mascot overlay — the whole (transparent, always-on-top) Electron
 *  window is the avatar plus one floating controls island. This is a fresh
 *  page instance with its own renderer/audio pipeline; continuity with the
 *  main window is by server-side session resume (#mascot-resume), exactly
 *  like the VR handoff. */
export default function MascotView() {
    const sv = useReactive(voice.state);
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
            console.error("[mascot] screen share failed", e);
        }
    };
    const [agents, setAgents] = useState([]);
    const [selectedAgentId, setSelectedAgentId] = useState(null);
    const [pinned, setPinned] = useState(true);
    const [fullBody, setFullBody] = useState(false);
    // Index 0 matches the shell's MASCOT_DEFAULT_SIZE (380×560).
    const [sizeIdx, setSizeIdx] = useState(0);
    const [ghost, setGhost] = useState(false);
    // Tray "Hide avatar controls": the island doesn't render at all — not
    // even on hover. Escape hatches stay in the tray (uncheck it, pop back).
    const [controlsHidden, setControlsHidden] = useState(false);
    const loadedAvatarId = useRef(null);
    const rootRef = useRef(null);
    const islandRef = useRef(null);
    // ignoring/faded are IPC/DOM side-effect mirrors, not render state.
    const ghostState = useRef({ ignoring: false, faded: false, lastSample: 0 });
    // #mascot-resume → pick the session the main window just ended back up.
    // Consumed once: the hash rewrites to plain #mascot so a manual reload
    // doesn't restart a call the user since ended.
    const autoResume = useRef(/^#mascot-resume/.test(window.location.hash));

    const isLive = sv.status === "live";
    const isConnecting = sv.status === "connecting";
    const busy = isLive || isConnecting;

    // Group calls: widen the window per extra character (the camera fits
    // the row horizontally, so extra width means bigger characters instead
    // of a zoomed-out squeeze) and mirror the main view's auto full-body
    // switch. Restores the current preset width when the call empties.
    // prev-ref guard: skip the mount run so a remembered scroll-resized
    // geometry isn't stomped back to the preset on every mascot open.
    const peerCount = (sv.peers || []).length;
    const prevPeerCount = useRef(0);
    useEffect(() => {
        if (peerCount === prevPeerCount.current) return;
        prevPeerCount.current = peerCount;
        if (peerCount > 0 && !fullBody) {
            setFullBody(true);
            avatarRenderer.setFullBodyMode?.(true);
        }
        const base = SIZES[sizeIdx];
        const width = Math.round(base.width * (1 + 0.55 * peerCount));
        window.rexclawDesktop?.setMascotSize?.({
            width, height: base.height, anchor: "bottom-center",
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peerCount]);

    const currentAgent = useMemo(
        () => agents.find((a) => Number(a.id) === Number(selectedAgentId)),
        [agents, selectedAgentId],
    );

    useEffect(() => {
        (async () => {
            try {
                const data = await rpc("/api/voice/agents", {});
                const list = data.agents || [];
                setAgents(list);
                // Same resolution as VoiceView: previous pick → default → first.
                const candidates = [voice.preferredAgentId, data.default_agent_id, list[0]?.id];
                for (const id of candidates) {
                    if (id && list.some((a) => a.id === Number(id))) {
                        setSelectedAgentId(Number(id));
                        break;
                    }
                }
            } catch (e) {
                console.error("[mascot] could not load agents", e);
            }
        })();
        return () => {
            avatarRenderer.setFullBodyMode?.(false);
        };
    }, []);

    // Island reveal — explicit events, never CSS :hover (see mascot.scss).
    // mousemove doubles as self-healing: any stale hidden/visible state
    // corrects itself on the next real movement inside the window.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const show = () => el.classList.add("is-cursor-inside");
        const hide = () => el.classList.remove("is-cursor-inside");
        el.addEventListener("mouseenter", show);
        el.addEventListener("mousemove", show);
        el.addEventListener("mouseleave", hide);
        return () => {
            el.removeEventListener("mouseenter", show);
            el.removeEventListener("mousemove", show);
            el.removeEventListener("mouseleave", hide);
        };
    }, []);

    // Tray checkbox state: fetch once, then follow pushes.
    useEffect(() => {
        const bridge = window.rexclawDesktop;
        bridge?.mascotControlsHidden?.().then((v) => setControlsHidden(!!v)).catch(() => {});
        bridge?.onMascotControlsHidden?.((v) => setControlsHidden(!!v));
    }, []);

    // Avatar hydration, minus everything mascot mode suppresses (backgrounds
    // paint nothing on a --mascot host). The stored outfit preference DOES
    // apply — without it this fresh page snapped back to the default outfit
    // even when the main window had another one selected.
    useEffect(() => {
        const avatar = currentAgent?.avatar;
        if (!avatar || !avatar.vrm_url) {
            avatarRenderer.configureFromAvatar(null);
            avatarRenderer.clearVRM?.();
            loadedAvatarId.current = null;
            return;
        }
        avatarRenderer.configureFromAvatar(avatar);
        if (loadedAvatarId.current === avatar.id) return;
        loadedAvatarId.current = avatar.id;
        avatarRenderer.resetExpression?.();
        const outfit = storedOutfit(avatar);
        if (outfit) voice.state.selectedOutfitId = Number(outfit.id);
        avatarRenderer.loadVRM(outfit?.vrm_url || avatar.vrm_url).catch((e) => {
            console.error("[mascot] avatar VRM load failed", e);
            loadedAvatarId.current = null;
        });
        if (avatar.vrma_idle_url) {
            avatarRenderer.loadVRMA(avatar.vrma_idle_url).catch(() => {});
        }
    }, [currentAgent]);

    const startOrResume = async () => {
        const sess = currentAgent?.last_resumable_session;
        try {
            // Group-call peers restore automatically: the resume payload
            // carries the last call roster and voice.start() re-adds them.
            await (sess ? voice.start(selectedAgentId, sess.id) : voice.start(selectedAgentId));
        } catch (e) {
            console.error("[mascot] call start failed", e);
        }
    };

    useEffect(() => {
        if (!autoResume.current || !currentAgent) return;
        autoResume.current = false;
        window.history.replaceState(null, "", window.location.pathname + "#mascot");
        startOrResume();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentAgent]);

    const popBackIn = async () => {
        const resume = busy;
        if (resume) await voice.end("client");
        // Reverse share handoff: this window (and its stream) is about to
        // close — flag it so the main window re-arms the same source.
        if (screenCapture.isArmed) {
            await window.rexclawDesktop?.shareHandoffSet?.();
            screenCapture.disarm();
        }
        window.rexclawDesktop?.closeMascot?.({ resume });
    };

    // Forward share handoff: if the main window had sharing armed when it
    // popped us out, silently re-arm the same source here (take() returns
    // null when nothing is pending, so this is a no-op otherwise).
    useEffect(() => {
        window.rexclawDesktop?.shareHandoffTake?.().then((src) => {
            if (src) screenCapture.armSilent(src);
        });
    }, []);

    // Tray → "Pop back in" routes through this page so a live call ends
    // cleanly before the window swap. Ref indirection: the handler is
    // registered once but must see current session state.
    const popBackInRef = useRef(popBackIn);
    popBackInRef.current = popBackIn;
    useEffect(() => {
        window.rexclawDesktop?.onMascotPopbackRequest?.(() => popBackInRef.current());
    }, []);

    // ---- ghost mode ---------------------------------------------------------
    // Clicks pass through the whole window — desktop icons, the app behind,
    // everything — except the controls island, and the avatar fades out of
    // the cursor's way (alpha hit-test with a fuzzy radius).
    // The shell streams global cursor positions because a click-through
    // window receives no native mouse events of its own.
    useEffect(() => {
        const bridge = window.rexclawDesktop;
        if (!ghost || !bridge?.setMascotGhost) return;
        let disposed = false;
        const host = () => rootRef.current?.querySelector(".o_voice_avatar_canvas--mascot");
        const setIgnore = (on) => {
            if (ghostState.current.ignoring === on) return;
            ghostState.current.ignoring = on;
            bridge.setMascotIgnoreMouse(on);
        };
        const setFade = (on) => {
            if (ghostState.current.faded === on) return;
            ghostState.current.faded = on;
            host()?.classList.toggle("is-ghost-faded", on);
        };
        bridge.onMascotCursor((c) => {
            if (disposed || !c) return;
            // Mirror :hover for the island reveal — a click-through window
            // gets no native hover on platforms without event forwarding.
            rootRef.current?.classList.toggle("is-cursor-inside", !!c.inside);
            if (!c.inside) {
                setIgnore(true);
                setFade(false);
                return;
            }
            // The island (plus a small halo) always stays clickable — it is
            // the only way back out of ghost mode.
            const island = islandRef.current?.getBoundingClientRect();
            if (island
                && c.x >= island.left - 12 && c.x <= island.right + 12
                && c.y >= island.top - 12 && c.y <= island.bottom + 12) {
                setIgnore(false);
                setFade(false);
                return;
            }
            setIgnore(true);
            // Sample at ~15 Hz — each sample is an extra render + GPU readback.
            const now = performance.now();
            if (now - ghostState.current.lastSample < 66) return;
            ghostState.current.lastSample = now;
            const { fuzzy } = avatarRenderer.sampleAlphaRegion?.(c.x, c.y, 24) || {};
            setFade(!!fuzzy);
        });
        bridge.setMascotGhost(true);
        setIgnore(true);
        return () => {
            disposed = true;
            bridge.setMascotGhost(false);   // also restores mouse events shell-side
            ghostState.current.ignoring = false;
            host()?.classList.remove("is-ghost-faded");
            ghostState.current.faded = false;
            rootRef.current?.classList.remove("is-cursor-inside");
        };
    }, [ghost]);

    const toggleGhost = () => setGhost((prev) => !prev);

    // ---- scroll-to-resize ---------------------------------------------------
    // Face view only: full-body view gives the wheel to OrbitControls
    // (camera zoom). Continuous window scaling: 5% per notch, uniform so
    // the aspect ratio holds, clamped to the shell's bounds. `pending` chains rapid
    // notches without re-reading innerWidth mid-flight (the IPC resize is
    // async), and expires so a stale size never seeds the next gesture.
    useEffect(() => {
        const bridge = window.rexclawDesktop;
        const el = rootRef.current?.querySelector(".o_voice_avatar_canvas--mascot");
        if (!el || !bridge?.setMascotSize || fullBody) return;
        let raf = 0;
        let pending = null;
        let lastTs = 0;
        const onWheel = (ev) => {
            ev.preventDefault();
            const now = performance.now();
            if (now - lastTs > 500) pending = null;
            lastTs = now;
            const base = pending || { width: window.innerWidth, height: window.innerHeight };
            const wanted = ev.deltaY < 0 ? 1.05 : 1 / 1.05;
            const factor = Math.min(
                Math.min(1000 / base.width, 1400 / base.height),
                Math.max(Math.max(220 / base.width, 320 / base.height), wanted),
            );
            pending = {
                width: Math.round(base.width * factor),
                height: Math.round(base.height * factor),
            };
            if (!raf) {
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    if (pending) bridge.setMascotSize({ ...pending, anchor: "bottom-center" });
                });
            }
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => {
            el.removeEventListener("wheel", onWheel);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [fullBody]);

    // ---- grab-the-character dragging ---------------------------------------
    // Face view only: full-body view gives the pointer to OrbitControls, and
    // ghost mode passes clicks through the avatar entirely. Manual because
    // -webkit-app-region:drag would swallow all canvas interaction — instead
    // pointer-capture the host and stream window origin + screen-space delta
    // to the shell (screen coords stay valid while the window itself moves).
    useEffect(() => {
        const bridge = window.rexclawDesktop;
        const el = rootRef.current?.querySelector(".o_voice_avatar_canvas--mascot");
        if (!el || !bridge?.mascotDragStart || fullBody || ghost) return;
        let start = null;   // {sx, sy, wx, wy, moved}
        let raf = 0;
        let next = null;
        const onDown = async (ev) => {
            if (ev.button !== 0) return;
            const origin = await bridge.mascotDragStart();
            if (!origin) return;
            start = { sx: ev.screenX, sy: ev.screenY, wx: origin.x, wy: origin.y, moved: false };
            try { el.setPointerCapture(ev.pointerId); } catch (e) { /* non-fatal */ }
        };
        const onMove = (ev) => {
            if (!start) return;
            const dx = ev.screenX - start.sx;
            const dy = ev.screenY - start.sy;
            // 4px threshold keeps plain clicks (future head pats) intact.
            if (!start.moved && dx * dx + dy * dy < 16) return;
            start.moved = true;
            next = { x: start.wx + dx, y: start.wy + dy };
            if (!raf) {
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    if (next && start) bridge.mascotDragMove(next);
                });
            }
        };
        const onUp = (ev) => {
            if (!start) return;
            try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* non-fatal */ }
            start = null;
            bridge.mascotDragEnd?.();
        };
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
        return () => {
            el.removeEventListener("pointerdown", onDown);
            el.removeEventListener("pointermove", onMove);
            el.removeEventListener("pointerup", onUp);
            el.removeEventListener("pointercancel", onUp);
            if (raf) cancelAnimationFrame(raf);
            if (start) bridge.mascotDragEnd?.();
        };
    }, [fullBody, ghost]);

    const togglePin = () => {
        const next = !pinned;
        setPinned(next);
        window.rexclawDesktop?.setMascotPin?.(next);
    };

    const cycleSize = () => {
        const next = (sizeIdx + 1) % SIZES.length;
        setSizeIdx(next);
        // Apply the group-call widening here too — cycling mid-call used to
        // snap back to the solo preset width and clip the outer characters.
        const base = SIZES[next];
        window.rexclawDesktop?.setMascotSize?.(peerCount > 0
            ? {
                width: Math.round(base.width * (1 + 0.55 * peerCount)),
                height: base.height,
                anchor: "bottom-center",
            }
            : base);
    };

    const toggleFullBody = () => {
        setFullBody((prev) => {
            avatarRenderer.setFullBodyMode?.(!prev);
            return !prev;
        });
    };

    const dismissError = () => {
        voice.state.errorMessage = null;
        if (voice.state.status === "error") voice.state.status = "idle";
    };

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

    return (
        <div className="rx_mascot" ref={rootRef}>
            <AvatarCanvas size="mascot" />
            {!controlsHidden && <div className="rx_mascot_island" ref={islandRef}>
                <span className="rx_mascot_drag" title={_t("Drag to move")}>
                    <i className="fa fa-arrows" />
                </span>
                <span
                    className={
                        "rx_mascot_status"
                        + (isLive ? " is-live" : "")
                        + (isConnecting ? " is-connecting" : "")
                    }
                    title={statusLabel}
                />
                {!busy && (
                    <button onClick={startOrResume}
                            title={currentAgent?.last_resumable_session ? _t("Resume last") : _t("Start")}>
                        <i className="fa fa-microphone" />
                    </button>
                )}
                {isLive && (
                    <button className={sv.muted ? "is-active" : ""}
                            onClick={() => voice.setMuted(!sv.muted)}
                            title={sv.muted ? _t("Unmute") : _t("Mute")}>
                        <i className={sv.muted ? "fa fa-microphone-slash" : "fa fa-microphone"} />
                    </button>
                )}
                {busy && (
                    <button onClick={() => voice.end("client")} title={_t("End")}>
                        <i className="fa fa-stop" />
                    </button>
                )}
                {screenCapture.isSupported && (
                    // The mascot runs its own page instance — the call (and
                    // its tool dispatcher) live HERE, so screen sharing must
                    // be armable here too or the capture tools would point
                    // the user at a button that doesn't exist.
                    <button className={scap.armed ? "is-active" : ""}
                            onClick={toggleScreenShare}
                            title={scap.recording
                                ? _t("Recording your screen…")
                                : scap.armed
                                    ? _t("Stop screen sharing")
                                    : _t("Share your screen — lets the companion take screenshots or record clips of it on request")}>
                        <i className={scap.recording ? "fa fa-circle text-danger" : "fa fa-desktop"} />
                    </button>
                )}
                <button className={fullBody ? "is-active" : ""} onClick={toggleFullBody}
                        title={fullBody
                            ? _t("Switch to face view")
                            : _t("Switch to full body (drag to rotate, scroll to zoom)")}>
                    <i className={fullBody ? "fa fa-user" : "fa fa-male"} />
                </button>
                <button className={pinned ? "is-active" : ""} onClick={togglePin}
                        title={_t("Always on top")}>
                    <i className="fa fa-thumb-tack" />
                </button>
                {!!window.rexclawDesktop?.setMascotGhost && (
                    <button className={ghost ? "is-active" : ""} onClick={toggleGhost}
                            title={_t("Ghost mode — clicks pass through the window; the avatar steps out of the cursor's way")}>
                        <i className="fa fa-low-vision" />
                    </button>
                )}
                <button onClick={cycleSize}
                        title={_t("Cycle window size — or scroll on the avatar for fine control")}>
                    <i className="fa fa-arrows-alt" />
                </button>
                <button onClick={popBackIn} title={_t("Back to the app window")}>
                    <i className="fa fa-window-restore" />
                </button>
            </div>}
            {sv.errorMessage && (
                <div className="rx_mascot_error" onClick={dismissError} title={_t("Dismiss")}>
                    {sv.errorMessage}
                </div>
            )}
        </div>
    );
}
