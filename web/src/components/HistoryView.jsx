import React, { useState } from "react";
import { _t } from "../lib/i18n";
import SessionsView from "./SessionsView.jsx";
import MemoriesView from "./MemoriesView.jsx";
import LoreStoriesPanel from "./LoreStoriesPanel.jsx";

/** History tab — Odoo-style umbrella over the three record views: Sessions
 *  (transcripts), Memories, and the Lore stories archive. Sub-views stay
 *  mounted (display:none) so switching between them keeps scroll positions
 *  and loaded data; each gets `active` only when both the tab and its
 *  sub-tab are current, preserving the refresh-on-activate behavior. */
const SUBTABS = [
    { id: "sessions", label: "Sessions", icon: "fa-archive" },
    { id: "memories", label: "Memories", icon: "fa-lightbulb-o" },
    { id: "lore", label: "Lore stories", icon: "fa-book" },
];

export default function HistoryView({ active }) {
    const [sub, setSub] = useState("sessions");
    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <div style={{ display: "flex", gap: "0.5rem", padding: "0.6rem 1rem 0.2rem" }}>
                {SUBTABS.map((t) => (
                    <button key={t.id}
                            className={"btn btn-sm" + (sub === t.id ? " btn-primary" : "")}
                            onClick={() => setSub(t.id)}>
                        <i className={"fa " + t.icon} /> {_t(t.label)}
                    </button>
                ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, display: sub === "sessions" ? "" : "none" }}>
                <SessionsView active={active && sub === "sessions"} />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: sub === "memories" ? "" : "none" }}>
                <MemoriesView active={active && sub === "memories"} />
            </div>
            <div style={{ flex: 1, minHeight: 0, display: sub === "lore" ? "" : "none" }}>
                <div className="rx_settings">
                    <div className="rx_settings_inner">
                        <section>
                            <LoreStoriesPanel />
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
