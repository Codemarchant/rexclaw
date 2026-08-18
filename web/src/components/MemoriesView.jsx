import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { EditorBar } from "./UnsavedUI.jsx";

/** Dedicated Memories tab — the durable facts and conversation episodes the
 *  companions have stored across sessions. Lives on its own tab (not buried in
 *  Settings) because the pool grows large over time, so it ships with search +
 *  type/scope filters; episodes expand to reveal their verbatim transcript. */
export default function MemoriesView({ active }) {
    const [memories, setMemories] = useState([]);
    const [agents, setAgents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState("");
    const [typeFilter, setTypeFilter] = useState("all");    // all | fact | episode
    const [scopeFilter, setScopeFilter] = useState("all");  // all | core | recall
    const [agentFilter, setAgentFilter] = useState("all");  // all | shared | String(agent id)
    const [expanded, setExpanded] = useState(() => new Set());
    const [editing, setEditing] = useState(null);           // null | {id?, content, scope, agent_id, tags, keywords?, memory_type}
    const [saving, setSaving] = useState(false);
    const importInputRef = useRef(null);

    const load = async () => {
        setLoading(true);
        try {
            const [mems, ags] = await Promise.all([
                rpc("/api/memories/list", {}),
                rpc("/api/agents/list", {}),
            ]);
            setMemories(mems);
            setAgents(ags);
        } catch (e) {
            notification.add(e?.message || _t("Could not load memories"), { type: "danger" });
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
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const startCreate = () =>
        setEditing({ content: "", scope: "recall", agent_id: null, tags: "", memory_type: "fact" });

    const startEdit = (m) =>
        setEditing({
            id: m.id,
            content: m.content || "",
            scope: m.scope,
            agent_id: m.agent_id,
            tags: m.tags || "",
            keywords: m.keywords || "",
            memory_type: m.memory_type,
        });

    const saveEditing = async () => {
        setSaving(true);
        try {
            const payload = {
                id: editing.id,
                content: editing.content,
                scope: editing.scope,
                agent_id: editing.agent_id,
                tags: editing.tags,
            };
            if (editing.memory_type === "episode") payload.keywords = editing.keywords;
            await rpc("/api/memories/save", payload);
            setEditing(null);
            await load();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
            return false;
        } finally {
            setSaving(false);
        }
    };

    // Unsaved-changes guard for the open editor: diff the draft against the
    // snapshot captured when it opened, so switching tabs mid-edit prompts.
    const editBaseline = useRef(null);
    useEffect(() => {
        if (editing && editBaseline.current === null) editBaseline.current = JSON.stringify(editing);
        else if (!editing) editBaseline.current = null;
    }, [editing]);
    const editDirty = !!editing && editBaseline.current !== null
        && JSON.stringify(editing) !== editBaseline.current;
    useUnsavedGuard(active, editDirty, saveEditing, () => setEditing(null));

    // Portable memories file (versioned JSON, shared with the Odoo module) —
    // the server owns the format; here we just move it in and out of a file.
    // Export follows the companion filter: an explicit agent_id null means
    // shared-only, omitting the key means everything.
    const exportMemories = async () => {
        try {
            const payload = {};
            let suffix = "";
            if (agentFilter === "shared") {
                payload.agent_id = null;
                suffix = "-shared";
            } else if (agentFilter !== "all") {
                payload.agent_id = Number(agentFilter);
                const name = agents.find((a) => a.id === payload.agent_id)?.name || "companion";
                suffix = "-" + (name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "companion");
            }
            const data = await rpc("/api/memories/export", payload);
            const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = `rexclaw-memories${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            notification.add(e?.message || _t("Export failed"), { type: "danger" });
        }
    };

    const importMemories = async (file) => {
        try {
            let data;
            try {
                data = JSON.parse(await file.text());
            } catch {
                throw new Error(_t("Not a valid JSON file."));
            }
            const res = await rpc("/api/memories/import", data);
            notification.add(
                _t("Imported %s memories (%s duplicates skipped).", res.imported, res.duplicates),
                { type: "success" }
            );
            if (res.unknown_agents?.length) {
                notification.add(
                    _t("Skipped memories of unknown companions: %s. Create them, then import again.",
                        res.unknown_agents.join(", ")),
                    { type: "warning", sticky: true }
                );
            }
            await load();
        } catch (e) {
            notification.add(e?.message || _t("Import failed"), { type: "danger" });
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
        if (agentFilter === "shared" && m.agent_id != null) return false;
        if (agentFilter !== "all" && agentFilter !== "shared" && m.agent_id !== Number(agentFilter)) return false;
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
                    <h3><i className="fa fa-lightbulb-o" /> {_t("Memories")}</h3>
                    <p className="text-muted small" style={{ marginTop: "-0.4rem" }}>
                        {_t("Durable facts and conversation episodes your companions remember across sessions — yours to review or forget at any time.")}
                    </p>

                    <div className="rx_mem_toolbar">
                        <input
                            type="text"
                            placeholder={_t("Search memories, keywords, tags…")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        <div className="rx_mem_filters">
                            {[
                                ["all", `${_t("All")} ${memories.length}`],
                                ["fact", `${_t("Facts")} ${factCount}`],
                                ["episode", `${_t("Episodes")} ${episodeCount}`],
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
                            value={agentFilter}
                            onChange={(e) => setAgentFilter(e.target.value)}
                            style={{ width: "auto" }}
                            title={_t("Filter by companion")}
                        >
                            <option value="all">{_t("All companions")}</option>
                            <option value="shared">{_t("Shared only")}</option>
                            {agents.map((a) => (
                                <option key={a.id} value={String(a.id)}>{a.name}</option>
                            ))}
                        </select>
                        <select
                            value={scopeFilter}
                            onChange={(e) => setScopeFilter(e.target.value)}
                            style={{ width: "auto" }}
                            title={_t("Filter by scope")}
                        >
                            <option value="all">{_t("All scopes")}</option>
                            <option value="core">{_t("Core")}</option>
                            <option value="recall">{_t("Recall")}</option>
                        </select>
                        <button className="btn btn-primary btn-sm" onClick={startCreate}>
                            <i className="fa fa-plus" /> {_t("New memory")}
                        </button>
                        <button
                            className="btn btn-secondary btn-sm"
                            title={_t("Download memories as a JSON file (follows the companion filter)")}
                            onClick={exportMemories}
                        >
                            <i className="fa fa-download" /> {_t("Export")}
                        </button>
                        <button
                            className="btn btn-secondary btn-sm"
                            title={_t("Import memories from an exported JSON file")}
                            onClick={() => importInputRef.current?.click()}
                        >
                            <i className="fa fa-upload" /> {_t("Import")}
                        </button>
                        <input
                            ref={importInputRef}
                            type="file"
                            accept=".json,application/json"
                            style={{ display: "none" }}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) importMemories(file);
                            }}
                        />
                    </div>

                    {editing && (
                        <div className="rx_mem_editor">
                            <label>{editing.id ? _t("Edit memory") : _t("New memory")}</label>
                            <textarea
                                rows={3}
                                autoFocus
                                placeholder={_t("A durable fact worth remembering, e.g. \"My favourite colour is teal.\"")}
                                value={editing.content}
                                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                            />
                            {editing.memory_type === "episode" && (
                                <div style={{ marginTop: "0.6rem" }}>
                                    <label>{_t("Keywords (what recall searches against)")}</label>
                                    <input
                                        type="text"
                                        value={editing.keywords}
                                        onChange={(e) => setEditing({ ...editing, keywords: e.target.value })}
                                    />
                                </div>
                            )}
                            <div className="rx_row" style={{ marginTop: "0.6rem" }}>
                                <div>
                                    <label>{_t("Scope")}</label>
                                    <select
                                        value={editing.scope}
                                        onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
                                    >
                                        <option value="recall">{_t("Recall — searched when relevant")}</option>
                                        <option value="core">{_t("Core — always in the prompt")}</option>
                                    </select>
                                </div>
                                <div>
                                    <label>{_t("Companion")}</label>
                                    <select
                                        value={editing.agent_id ?? ""}
                                        onChange={(e) =>
                                            setEditing({ ...editing, agent_id: e.target.value ? Number(e.target.value) : null })
                                        }
                                    >
                                        <option value="">{_t("All companions")}</option>
                                        {agents.map((a) => (
                                            <option key={a.id} value={a.id}>{a.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label>{_t("Tags (comma-separated)")}</label>
                                    <input
                                        type="text"
                                        placeholder={_t("preferences, colors")}
                                        value={editing.tags}
                                        onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
                                    />
                                </div>
                            </div>
                            <EditorBar
                                dirty={editDirty}
                                saving={saving}
                                onSave={saveEditing}
                                onCancel={() => setEditing(null)}
                                saveLabel={editing.id ? _t("Save") : _t("Add memory")}
                                saveDisabled={!editing.content.trim()} />
                        </div>
                    )}

                    {loading && <p className="text-muted small">{_t("Loading…")}</p>}
                    {!loading && !memories.length && (
                        <p className="text-muted small">
                            {_t("Nothing remembered yet — companions store durable facts and episodes here as you talk.")}
                        </p>
                    )}
                    {!loading && !!memories.length && !visible.length && (
                        <p className="text-muted small">{_t("No memories match your filters.")}</p>
                    )}

                    {visible.map((m) => {
                        const isEpisode = m.memory_type === "episode";
                        const isOpen = expanded.has(m.id);
                        return (
                            <div key={m.id} className="rx_mem_item">
                                <div className="rx_memory_row">
                                    <span className={"rx_mem_badge" + (isEpisode ? " rx_mem_badge--episode" : "")}>
                                        {isEpisode ? _t("episode") : _t("fact")}
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
                                                {isOpen ? " " + _t("hide transcript") : " " + _t("transcript")}
                                            </button>
                                        )}
                                    </span>
                                    <span className="rx_memory_meta">
                                        {m.agent_name || _t("all companions")}{m.tags ? ` · ${m.tags}` : ""}
                                    </span>
                                    <button
                                        className="btn btn-sm btn-link p-0"
                                        title={_t("Edit")}
                                        onClick={() => startEdit(m)}
                                    >
                                        <i className="fa fa-pencil" />
                                    </button>
                                    <button
                                        className="btn btn-sm btn-link p-0"
                                        title={_t("Forget")}
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
