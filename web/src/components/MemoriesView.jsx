import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";

/** Dedicated Memories tab — the durable facts and conversation episodes the
 *  companions have stored across sessions. Lives on its own tab (not buried in
 *  Settings) because the pool grows large over time, so it ships with search +
 *  type/scope filters; episodes expand to reveal their verbatim transcript. */
export default function MemoriesView({ active }) {
    const [memories, setMemories] = useState([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState("all");    // all | fact | episode
    const [scopeFilter, setScopeFilter] = useState("all");  // all | core | recall
    const [expanded, setExpanded] = useState(() => new Set());

    const load = async () => {
        setLoading(true);
        try {
            setMemories(await rpc("/api/memories/list", {}));
        } catch (e) {
            notification.add(e?.message || "Could not load memories", { type: "danger" });
        } finally {
            setLoading(false);
        }
    };

    // Reload each time the tab becomes active so freshly-extracted memories show.
    useEffect(() => {
        if (active) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const deleteMemory = async (id) => {
        try {
            await rpc("/api/memories/delete", { id });
            setMemories((m) => m.filter((x) => x.id !== id));
        } catch (e) {
            notification.add(e?.message || "Delete failed", { type: "danger" });
        }
    };

    const toggleExpand = (id) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const q = query.trim().toLowerCase();
    const visible = memories.filter((m) => {
        const type = m.memory_type === "episode" ? "episode" : "fact";
        if (typeFilter !== "all" && type !== typeFilter) return false;
        if (scopeFilter !== "all" && m.scope !== scopeFilter) return false;
        if (!q) return true;
        return [m.content, m.keywords, m.tags, m.agent_name]
            .some((f) => (f || "").toLowerCase().includes(q));
    });

    const factCount = memories.filter((m) => m.memory_type !== "episode").length;
    const episodeCount = memories.length - factCount;

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-lightbulb-o" /> Memories</h3>
                    <p className="text-muted small" style={{ marginTop: "-0.4rem" }}>
                        Durable facts and conversation episodes your companions remember
                        across sessions — yours to review or forget at any time.
                    </p>

                    <div className="rx_mem_toolbar">
                        <input
                            type="text"
                            placeholder="Search memories, keywords, tags…"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        <div className="rx_mem_filters">
                            {[
                                ["all", `All ${memories.length}`],
                                ["fact", `Facts ${factCount}`],
                                ["episode", `Episodes ${episodeCount}`],
                            ].map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    className={"rx_mem_chip" + (typeFilter === id ? " is-active" : "")}
                                    onClick={() => setTypeFilter(id)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <select
                            value={scopeFilter}
                            onChange={(e) => setScopeFilter(e.target.value)}
                            style={{ width: "auto" }}
                            title="Filter by scope"
                        >
                            <option value="all">All scopes</option>
                            <option value="core">Core</option>
                            <option value="recall">Recall</option>
                        </select>
                    </div>

                    {loading && <p className="text-muted small">Loading…</p>}
                    {!loading && !memories.length && (
                        <p className="text-muted small">
                            Nothing remembered yet — companions store durable facts and
                            episodes here as you talk.
                        </p>
                    )}
                    {!loading && !!memories.length && !visible.length && (
                        <p className="text-muted small">No memories match your filters.</p>
                    )}

                    {visible.map((m) => {
                        const isEpisode = m.memory_type === "episode";
                        const isOpen = expanded.has(m.id);
                        return (
                            <div key={m.id} className="rx_mem_item">
                                <div className="rx_memory_row">
                                    <span className={"rx_mem_badge" + (isEpisode ? " rx_mem_badge--episode" : "")}>
                                        {isEpisode ? "episode" : "fact"}
                                    </span>
                                    <span className="rx_memory_scope">{m.scope}</span>
                                    <span className="rx_memory_content">
                                        {m.content}
                                        {isEpisode && m.transcript && (
                                            <button
                                                type="button"
                                                className="rx_mem_expand"
                                                onClick={() => toggleExpand(m.id)}
                                            >
                                                <i className={"fa " + (isOpen ? "fa-chevron-up" : "fa-chevron-down")} />
                                                {isOpen ? " hide transcript" : " transcript"}
                                            </button>
                                        )}
                                    </span>
                                    <span className="rx_memory_meta">
                                        {m.agent_name || "all companions"}{m.tags ? ` · ${m.tags}` : ""}
                                    </span>
                                    <button
                                        className="btn btn-sm btn-link p-0"
                                        title="Forget"
                                        onClick={() => deleteMemory(m.id)}
                                    >
                                        <i className="fa fa-trash-o" />
                                    </button>
                                </div>
                                {isEpisode && isOpen && m.transcript && (
                                    <pre className="rx_mem_transcript">{m.transcript}</pre>
                                )}
                            </div>
                        );
                    })}
                </section>
            </div>
        </div>
    );
}
