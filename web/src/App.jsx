import React, { useState } from "react";
import VoiceView from "./components/VoiceView.jsx";
import TextView from "./components/TextView.jsx";
import MemoriesView from "./components/MemoriesView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import Toasts from "./components/Toasts.jsx";
import { uiState, toggleImmersive } from "./lib/ui_state";
import { useReactive } from "./lib/reactive";

const TABS = [
    { id: "voice", label: "Voice", icon: "fa-microphone" },
    { id: "chat", label: "Chat", icon: "fa-comments" },
    { id: "memories", label: "Memories", icon: "fa-lightbulb-o" },
    { id: "settings", label: "Settings", icon: "fa-cog" },
];

export default function App() {
    const [tab, setTab] = useState("voice");
    const ui = useReactive(uiState);
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
                    <i className="fa fa-paw" /> <span className="rx_label">Rexclaw</span>
                </span>
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        className={"rx_tab" + (tab === t.id ? " is-active" : "")}
                        onClick={() => setTab(t.id)}
                        title={t.label}
                    >
                        <i className={"fa " + t.icon} /> <span className="rx_label">{t.label}</span>
                    </button>
                ))}
                {tab === "voice" && (
                    <button className="rx_tab rx_tab--immersive" onClick={toggleImmersive}
                            title="Immersive view — hide all UI for a full-screen avatar (H · Esc to exit)">
                        <i className="fa fa-expand" /> <span className="rx_label">Immersive</span>
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
                <div className="rx_view" style={{ display: tab === "settings" ? "" : "none" }}>
                    <SettingsView active={tab === "settings"} />
                </div>
            </main>
            <Toasts />
        </div>
    );
}
