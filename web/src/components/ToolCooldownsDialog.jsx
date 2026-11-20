import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";

const UNITS = [["s", 1, "seconds"], ["m", 60, "minutes"], ["h", 3600, "hours"]];
const factorOf = (unit) => UNITS.find(([u]) => u === unit)[1];

function parseCooldowns(text) {
    try {
        const v = JSON.parse(text || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
}

/** A saved wait in seconds as the field shows it: the largest unit it is a
 *  whole number of. */
function fieldOf(seconds) {
    if (!(seconds > 0)) return { amount: "", unit: "m" };
    const [unit, factor] = [...UNITS].reverse().find(([, f]) => seconds % f === 0);
    return { amount: String(seconds / factor), unit };
}

/** Tool cooldowns: every tool the app runs for this companion, each with an
 *  optional wait before the companion can call it again
 *  (server/tool_cooldowns.py). Edits go straight into the editor's draft
 *  (agents.tool_cooldowns, {tool name: seconds}), so the editor's Save and
 *  Discard apply to them like any other field. */
export default function ToolCooldownsDialog({ editingAgent, setEditingAgent, onClose }) {
    const [tools, setTools] = useState(null);
    const [error, setError] = useState(null);
    // {tool name: {amount, unit}} as typed; a tool not touched yet shows
    // its saved wait.
    const [fields, setFields] = useState({});
    const saved = parseCooldowns(editingAgent.tool_cooldowns);

    useEffect(() => {
        let alive = true;
        rpc("/api/agents/cooldown_tools", { id: editingAgent.id, values: editingAgent })
            .then((res) => { if (alive) setTools(res.tools || []); })
            .catch((e) => { if (alive) setError(e?.message || _t("Could not load the tools.")); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Sorted keys, compact: the form the server saves it in, so an edit
    // taken back reads as unchanged.
    const write = (cooldowns) => setEditingAgent({
        ...editingAgent,
        tool_cooldowns: JSON.stringify(Object.fromEntries(
            Object.entries(cooldowns).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
    });
    const setField = (name, field) => {
        setFields({ ...fields, [name]: field });
        const seconds = Math.round(parseFloat(field.amount) * factorOf(field.unit));
        const { [name]: _old, ...rest } = saved;
        write(seconds > 0 ? { ...rest, [name]: seconds } : rest);
    };
    const clearAll = () => { setFields({}); write({}); };

    // A tool with a wait that isn't offered right now (its switch is off,
    // its app isn't connected) stays listed, so the wait can be seen and
    // removed.
    const listed = tools && [
        ...tools,
        ...Object.keys(saved).filter((name) => !tools.some((t) => t.name === name))
            .map((name) => ({ name, missing: true })),
    ];
    const where = (tool) => (tool.missing ? _t("not offered right now")
        : tool.voice && tool.text ? "" : tool.voice ? _t("calls only") : _t("text chat only"));

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className="rx_dialog rx_dialog--cooldowns" role="dialog" aria-modal="true"
                 onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Tool cooldowns")}{editingAgent.name ? ` — ${editingAgent.name}` : ""}</h4>
                <p>
                    {_t("Make this companion wait before it can use a tool again. A call made during the wait isn't run: the companion is told the tool is on cooldown and how long is left. Leave a tool empty for no cooldown. Applies from the next call or message once saved, and isn't included in companion exports.")}
                </p>
                <div className="rx_cooldowns_body">
                    {!tools && !error && <div className="rx_cooldowns_msg">{_t("Loading…")}</div>}
                    {error && <div className="rx_cooldowns_msg is-error">{error}</div>}
                    {listed && listed.length === 0 && (
                        <div className="rx_cooldowns_msg">{_t("This companion has no tools switched on.")}</div>
                    )}
                    {listed && listed.map((tool) => {
                        const field = fields[tool.name] || fieldOf(saved[tool.name]);
                        return (
                            <div key={tool.name} className={`rx_cooldowns_row${saved[tool.name] ? " is-set" : ""}`}>
                                <span className="rx_cooldowns_name" title={tool.description || undefined}>
                                    {tool.name}
                                    {where(tool) && <span className="text-muted small"> · {where(tool)}</span>}
                                </span>
                                <input type="number" min={0} step="any" value={field.amount}
                                       placeholder={_t("none")} aria-label={_t("Cooldown for %s", tool.name)}
                                       onChange={(ev) => setField(tool.name, { ...field, amount: ev.target.value })} />
                                <select value={field.unit} aria-label={_t("Unit")}
                                        onChange={(ev) => setField(tool.name, { ...field, unit: ev.target.value })}>
                                    {UNITS.map(([unit, , label]) => <option key={unit} value={unit}>{_t(label)}</option>)}
                                </select>
                            </div>
                        );
                    })}
                </div>
                <p className="small">
                    {_t("Web search, X search, code execution and remote MCP servers are run by the brain's provider, not the app, so they can't have a cooldown.")}
                </p>
                <div className="rx_dialog_actions">
                    {Object.keys(saved).length > 0 && (
                        <button className="btn btn-secondary" onClick={clearAll}>{_t("Clear all")}</button>
                    )}
                    <button className="btn btn-primary" onClick={onClose}>{_t("Done")}</button>
                </div>
            </div>
        </div>
    );
}
