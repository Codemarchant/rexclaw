import React, { useEffect, useState } from "react";
import VoiceView from "./components/VoiceView.jsx";
import TextView from "./components/TextView.jsx";
import HistoryView from "./components/HistoryView.jsx";
import CompanionsView from "./components/CompanionsView.jsx";
import AvatarsView from "./components/AvatarsView.jsx";
import GameIntegrationsView from "./components/GameIntegrationsView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import MascotView from "./components/MascotView.jsx";
import MascotSettingsView from "./components/MascotSettingsView.jsx";
import TranscriptWindowView from "./components/TranscriptWindowView.jsx";
import Toasts from "./components/Toasts.jsx";
import ConfirmDialog from "./components/ConfirmDialog.jsx";
import { UnsavedDialog } from "./components/UnsavedUI.jsx";
import { unsavedGuard, getUnsavedHandlers, clearUnsaved } from "./lib/unsaved_guard";
import { uiState, toggleImmersive, MASCOT_MODE, MASCOT_SETTINGS_MODE, TRANSCRIPT_MODE } from "./lib/ui_state";
import { startHotkeys } from "./lib/hotkeys";
import { wakeWord } from "./lib/wake_word";
import { heartbeatCall } from "./lib/heartbeat_call";
import { startTranscriptOwner } from "./services/transcript_sync";
import { useReactive } from "./lib/reactive";
import { _t, i18nState } from "./lib/i18n";

const TABS = [
    { id: "voice", label: "Voice", icon: "fa-microphone" },
    { id: "chat", label: "Chat", icon: "fa-comments" },
    { id: "history", label: "History", icon: "fa-history" },
    { id: "companions", label: "Companions", icon: "fa-users" },
    { id: "avatars", label: "Avatars", icon: "fa-user-circle-o" },
    { id: "games", label: "Games", icon: "fa-gamepad" },
    { id: "settings", label: "Settings", icon: "fa-cog" },
];

export default function App() {
    const [tab, setTab] = useState("voice");
    // Odoo-style unsaved-changes guard. `pendingTab` holds the tab we're
    // trying to reach while the leave prompt is open.
    const [pendingTab, setPendingTab] = useState(null);
    const [leaveSaving, setLeaveSaving] = useState(false);
    const guard = useReactive(unsavedGuard);
    const ui = useReactive(uiState);

    // Guarded navigation: switch immediately when clean, otherwise open the
    // Save / Discard / Cancel prompt and defer the switch to its resolution.
    const requestTab = (next) => {
        if (!next || next === tab) return;
        if (unsavedGuard.dirty) setPendingTab(next);
        else setTab(next);
    };

    const resolveLeave = async (action) => {
        if (action === "cancel") { setPendingTab(null); return; }
        const handlers = getUnsavedHandlers();
        if (action === "save") {
            setLeaveSaving(true);
            let ok = false;
            try { ok = await handlers.save?.(); } catch (e) { ok = false; }
            setLeaveSaving(false);
            if (ok === false) return;   // save failed — keep the prompt, stay put
        } else if (action === "discard") {
            try { await handlers.discard?.(); } catch (e) { /* revert best-effort */ }
        }
        clearUnsaved();
        const next = pendingTab;
        setPendingTab(null);
        if (next) setTab(next);
    };

    // Browser / Electron window close: the native prompt is the only guard
    // available here (no custom Save/Discard on unload).
    useEffect(() => {
        const onBeforeUnload = (e) => {
            if (unsavedGuard.dirty) { e.preventDefault(); e.returnValue = ""; }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, []);
    // Subscribing App to the locale makes a language switch re-render the
    // whole mounted tree in place — children aren't memoized, and nothing
    // remounts, so a live voice session survives the flip.
    useReactive(i18nState);
    // Tab handoff from the Sessions tab (Resume buttons set requestedTab).
    useEffect(() => {
        if (ui.requestedTab) {
            requestTab(ui.requestedTab);
            uiState.requestedTab = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ui.requestedTab]);
    // Any call-capable page (main view or mascot) mirrors its transcript to
    // /#transcript windows; mirror windows themselves stay passive — and so
    // does the mascot settings window, which never owns a call.
    useEffect(() => {
        if (!TRANSCRIPT_MODE && !MASCOT_SETTINGS_MODE) startTranscriptOwner();
    }, []);
    // Keyboard shortcuts: every page instance loads the bindings and listens.
    // The views register the handlers for the actions they own.
    useEffect(() => startHotkeys(), []);
    // Voice activation standby ("hey Eve") — the service no-ops unless the
    // feature is enabled and elects one window to hold the mic.
    useEffect(() => { wakeWord.start(); }, []);
    // Heartbeat call mode — one elected window polls for due "call the
    // user" heartbeats and answers by starting the call.
    useEffect(() => { heartbeatCall.start(); }, []);
    // In immersive mode on the Voice tab, hide the whole header for a pure
    // full-screen avatar. Other tabs always keep their header.
    const hideHeader = ui.immersive && tab === "voice";
    // Desktop mascot overlay: the whole window IS the avatar — no tabs, no
    // header, just the pop-out view with its floating controls. (Constant
    // for the window's lifetime, so the early return can't reorder hooks.)
    if (MASCOT_MODE) {
        return (
            <div className="rx_mascot_app">
                <MascotView />
                <Toasts />
            </div>
        );
    }
    if (MASCOT_SETTINGS_MODE) {
        return (
            <>
                <MascotSettingsView />
                <Toasts />
            </>
        );
    }
    if (TRANSCRIPT_MODE) {
        return (
            <>
                <TranscriptWindowView />
                <Toasts />
            </>
        );
    }
    // Views stay mounted across tab switches (display:none) so a live voice
    // session keeps running while the user peeks at chat or settings — the
    // renderer canvas, WebSocket and mic all survive.
    return (
        <div className="rx_app">
            {!hideHeader && <nav className="rx_tabbar">
                <span className="rx_brand" title="Rexclaw Companions">
                    <img className="rx_brand_icon" src="/icons/lobster.png" alt="" /> <span className="rx_label">Rexclaw</span>
                </span>
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        className={"rx_tab" + (tab === t.id ? " is-active" : "")}
                        onClick={() => requestTab(t.id)}
                        title={_t(t.label)}
                    >
                        <i className={"fa " + t.icon} /> <span className="rx_label">{_t(t.label)}</span>
                        {tab === t.id && guard.dirty && (
                            <span className="rx_tab_dirty" title={_t("Unsaved changes")} />
                        )}
                    </button>
                ))}
                {tab === "voice" && (
                    <button className="rx_tab rx_tab--immersive" onClick={toggleImmersive}
                            title={_t("Immersive view — hide all UI for a full-screen avatar (H · Esc to exit)")}>
                        <i className="fa fa-expand" /> <span className="rx_label">{_t("Immersive")}</span>
                    </button>
                )}
            </nav>}
            <main className="rx_main">
                <div className="rx_view" style={{ display: tab === "voice" ? "" : "none" }}>
                    <VoiceView active={tab === "voice"} />
                </div>
                <div className="rx_view" style={{ display: tab === "chat" ? "" : "none" }}>
                    <TextView active={tab === "chat"} />
                </div>
                <div className="rx_view" style={{ display: tab === "history" ? "" : "none" }}>
                    <HistoryView active={tab === "history"} />
                </div>
                <div className="rx_view" style={{ display: tab === "companions" ? "" : "none" }}>
                    <CompanionsView active={tab === "companions"} />
                </div>
                <div className="rx_view" style={{ display: tab === "avatars" ? "" : "none" }}>
                    <AvatarsView active={tab === "avatars"} />
                </div>
                <div className="rx_view" style={{ display: tab === "games" ? "" : "none" }}>
                    <GameIntegrationsView active={tab === "games"} />
                </div>
                <div className="rx_view" style={{ display: tab === "settings" ? "" : "none" }}>
                    <SettingsView active={tab === "settings"} />
                </div>
            </main>
            <UnsavedDialog
                open={!!pendingTab}
                saving={leaveSaving}
                onSave={() => resolveLeave("save")}
                onDiscard={() => resolveLeave("discard")}
                onCancel={() => resolveLeave("cancel")} />
            <ConfirmDialog />
            <Toasts />
        </div>
    );
}
