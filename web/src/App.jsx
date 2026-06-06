import React, { useState } from "react";
import VoiceView from "./components/VoiceView.jsx";
import TextView from "./components/TextView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import Toasts from "./components/Toasts.jsx";

const TABS = [
    { id: "voice", label: "Voice", icon: "fa-microphone" },
    { id: "chat", label: "Chat", icon: "fa-comments" },
    { id: "settings", label: "Settings", icon: "fa-cog" },
];

export default function App() {
    const [tab, setTab] = useState("voice");
    // Views stay mounted across tab switches (display:none) so a live voice
    // session keeps running while the user peeks at chat or settings — the
    // renderer canvas, WebSocket and mic all survive.
    return (
        <div className="rx_app">
            <nav className="rx_tabbar">
                <span className="rx_brand" title="Rexclaw Companions">
                    <i className="fa fa-paw" /> Rexclaw
                </span>
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        className={"rx_tab" + (tab === t.id ? " is-active" : "")}
                        onClick={() => setTab(t.id)}
                    >
                        <i className={"fa " + t.icon} /> {t.label}
                    </button>
                ))}
            </nav>
            <main className="rx_main">
                <div className="rx_view" style={{ display: tab === "voice" ? "" : "none" }}>
                    <VoiceView active={tab === "voice"} />
                </div>
                <div className="rx_view" style={{ display: tab === "chat" ? "" : "none" }}>
                    <TextView active={tab === "chat"} />
                </div>
                <div className="rx_view" style={{ display: tab === "settings" ? "" : "none" }}>
                    <SettingsView active={tab === "settings"} />
                </div>
            </main>
            <Toasts />
        </div>
    );
}
