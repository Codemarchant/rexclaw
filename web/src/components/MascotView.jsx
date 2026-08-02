import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { voice, avatarRenderer } from "../services";
import AvatarCanvas from "./AvatarCanvas.jsx";

// Window sizes the ⤢ button cycles through (bottom-right corner anchored by
// the shell). Portrait 2:3-ish — a standing character's natural frame.
const SIZES = [
    { width: 280, height: 420 },
    { width: 380, height: 560 },
    { width: 480, height: 700 },
];

/** Desktop mascot overlay — the whole (transparent, always-on-top) Electron
 *  window is the avatar plus one floating controls island. This is a fresh
 *  page instance with its own renderer/audio pipeline; continuity with the
 *  main window is by server-side session resume (#mascot-resume), exactly
 *  like the VR handoff. */
export default function MascotView() {
    const sv = useReactive(voice.state);
    const [agents, setAgents] = useState([]);
    const [selectedAgentId, setSelectedAgentId] = useState(null);
    const [pinned, setPinned] = useState(true);
    const [fullBody, setFullBody] = useState(false);
    const [sizeIdx, setSizeIdx] = useState(1);
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
    // paint nothing on a --mascot host; outfit prefs live in the main window).
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
        avatarRenderer.loadVRM(avatar.vrm_url).catch((e) => {
            console.error("[mascot] avatar VRM load failed", e);
            loadedAvatarId.current = null;
        });
        if (avatar.vrma_idle_url) {
            avatarRenderer.loadVRMA(avatar.vrma_idle_url).catch(() => {});
        }
    }, [currentAgent]);

    const startOrResume = () => {
        const sess = currentAgent?.last_resumable_session;
        (sess ? voice.start(selectedAgentId, sess.id) : voice.start(selectedAgentId))
            .catch((e) => console.error("[mascot] call start failed", e));
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
        window.rexclawDesktop?.closeMascot?.({ resume });
    };

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
        window.rexclawDesktop?.setMascotSize?.(SIZES[next]);
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
