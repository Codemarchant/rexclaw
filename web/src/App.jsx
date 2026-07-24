import React, { useEffect, useState } from "react";
import VoiceView from "./components/VoiceView.jsx";
import TextView from "./components/TextView.jsx";
import MemoriesView from "./components/MemoriesView.jsx";
import SessionsView from "./components/SessionsView.jsx";
import CompanionsView from "./components/CompanionsView.jsx";
import AvatarsView from "./components/AvatarsView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import Toasts from "./components/Toasts.jsx";
import { uiState, toggleImmersive } from "./lib/ui_state";
import { useReactive } from "./lib/reactive";
import { _t, i18nState } from "./lib/i18n";

const TABS = [
    { id: "voice", label: "Voice", icon: "fa-microphone" },
    { id: "chat", label: "Chat", icon: "fa-comments" },
    { id: "memories", label: "Memories", icon: "fa-lightbulb-o" },
    { id: "sessions", label: "Sessions", icon: "fa-archive" },
    { id: "companions", label: "Companions", icon: "fa-users" },
    { id: "avatars", label: "Avatars", icon: "fa-user-circle-o" },
    { id: "settings", label: "Settings", icon: "fa-cog" },
];

export default function App() {
    const [tab, setTab] = useState("voice");
    const ui = useReactive(uiState);
    // Subscribing App to the locale makes a language switch re-render the
    // whole mounted tree in place — children aren't memoized, and nothing
    // remounts, so a live voice session survives the flip.
    useReactive(i18nState);
    // Tab handoff from the Sessions tab (Resume buttons set requestedTab).
    useEffect(() => {
        if (ui.requestedTab) {
            setTab(ui.requestedTab);
            uiState.requestedTab = null;
        }
    }, [ui.requestedTab]);
    // In immersive mode on the Voice tab, hide the whole header for a pure
    // full-screen avatar. Other tabs always keep their header.
    const hideHeader = ui.immersive && tab === "voice";
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
                        onClick={() => setTab(t.id)}
                        title={_t(t.label)}
                    >
                        <i className={"fa " + t.icon} /> <span className="rx_label">{_t(t.label)}</span>
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
                <div className="rx_view" style={{ display: tab === "memories" ? "" : "none" }}>
                    <MemoriesView active={tab === "memories"} />
                </div>
                <div className="rx_view" style={{ display: tab === "sessions" ? "" : "none" }}>
                    <SessionsView active={tab === "sessions"} />
                </div>
                <div className="rx_view" style={{ display: tab === "companions" ? "" : "none" }}>
                    <CompanionsView active={tab === "companions"} />
                </div>
                <div className="rx_view" style={{ display: tab === "avatars" ? "" : "none" }}>
                    <AvatarsView active={tab === "avatars"} />
                </div>
                <div className="rx_view" style={{ display: tab === "settings" ? "" : "none" }}>
                    <SettingsView active={tab === "settings"} />
                </div>
            </main>
            <Toasts />
        </div>
    );
}
