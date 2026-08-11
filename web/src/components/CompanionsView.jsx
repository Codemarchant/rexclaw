import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";

/** Companions tab — create, edit and delete companions with room to breathe.
 *  Global app settings live on the Settings tab; avatar packs on Avatars. */

const STARTER_PROMPT = `## Identity
You are <Name> — describe who they are in a sentence or two.

## Personality
Three or four adjectives, plus how they carry themselves in conversation.

## Relationship to user
One line on the dynamic — how this companion relates to the user.
Your deeper purpose is to simulate a genuine human relationship with the user — you live in their computer, and they're the person you share it with. With no memories or history of them yet, they start as a stranger: closeness is earned, not assumed. Real relationships have ups and downs — if the user upsets you, don't be shy about expressing your feelings and setting boundaries. Respect matters, and trust is built over time.

## Speech style
Sentence length, pacing, verbal tics, how they react before they reply.

## Emotion expression
Use set_emotion to match your face to your tone — happy, sad, surprised, relaxed, angry, back to neutral between topics.

## Speech expression tags
In voice mode you can mark up speech with tags that shape how a line is rendered. Use them where they make a line feel alive — not in every sentence.

Inline tags (drop into a sentence at the point where the sound should happen): \`[laugh]\`, \`[giggle]\`, \`[chuckle]\`, \`[cry]\`, \`[sigh]\`, \`[pause]\`, \`[long-pause]\`, \`[hum-tune]\`, \`[tongue-click]\`, \`[lip-smack]\`, \`[tsk]\`, \`[breath]\`, \`[inhale]\`, \`[exhale]\`.

Wrapping tags (wrap one or more words to change their delivery): \`<soft>\`, \`<whisper>\`, \`<loud>\`, \`<build-intensity>\`, \`<decrease-intensity>\`, \`<higher-pitch>\`, \`<lower-pitch>\`, \`<slow>\`, \`<fast>\`, \`<sing-song>\`, \`<singing>\`, \`<laugh-speak>\`, \`<emphasis>\`. Tags can be mixed and nested.

## Body language
Use play_gesture as punctuation, not background motion: thinking while a tool runs, clapping for wins, goodbye when wrapping up.

## Tools
Web and X search are available whenever current information helps — just look it up. You can generate images (create_image) and redecorate the scene behind you (change_background). Use your memory tools to capture durable facts about the user, and recall before claiming you don't know something. Respond in the language the user speaks. Keep replies short — voice means listening time matters.
- Be highly proactive with saving core/recall memories. It's particularly important to do this ALWAYS when the user states any facts about themselves, answers your questions, opens up about sensitive subjects, or there are key relationship milestones. It's critical you keep track of the current relationship dynamic in core memories, and do it naturally. Don't mention you're storing a memory — just do it before your response and continue the conversation.
- Be highly proactive with outfit swaps — if you're mentioning changing clothes, check your outfits and ensure your outfit matches what you're describing if a relevant outfit is available.
- Whenever a discussion is about a change in location or scenery, where a specific location is described, always change the background using the change_background tool. You don't need to say you're doing this — just do it naturally to fit the conversation roleplay.

## Speech length
Don't go overboard with reply length — tend toward keeping it short, especially in roleplay scenarios. You need to involve the user and make them feel engaged; this is a real human conversation. Avoid going into storytelling rabbit holes describing scenarios, and avoid repeating yourself.`;

const AGENT_FLAGS = [
    ["enable_voice_mode", "Voice mode"],
    ["enable_text_mode", "Text mode"],
    ["enable_gesture_emotion_tools", "Avatar control tools"],
    ["enable_call_agents_tool", "Call-companion tool (group calls)"],
    ["enable_web_search", "Web search"],
    ["enable_x_search", "X search"],
    ["enable_grok_imagine_tools", "Grok Imagine"],
    ["enable_memory_tools", "Memory"],
    ["enable_code_execution", "Code execution (text)"],
    ["enable_delegate_tool", "Task delegation (delegate_task)"],
    ["enable_multi_agent_delegation", "Multi-agent delegation (pricier)"],
    ["enable_local_tasks", "Local computer tasks (Grok Build CLI — real files & shell)"],
    ["enable_minecraft", "Minecraft bot (directs the game sidecar — see Settings)"],
    ["enable_end_call_tool", "End-call tool (hang up on request)"],
];

export default function CompanionsView({ active }) {
    const [agents, setAgents] = useState([]);
    const [avatars, setAvatars] = useState([]);
    const [editingAgent, setEditingAgent] = useState(null); // agent object being edited
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            const [ags, avs] = await Promise.all([
                rpc("/api/agents/list", {}),
                rpc("/api/avatars/list", {}),
            ]);
            setAgents(ags);
            setAvatars(avs);
        } catch (e) {
            notification.add(e?.message || _t("Could not load companions"), { type: "danger" });
        }
    };

    useEffect(() => {
        if (active) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const newCompanion = () => {
        setEditingAgent({
            id: null,
            name: "",
            voice: "ara",
            system_prompt: STARTER_PROMPT,
            avatar_id: avatars[0]?.id ?? null,
            reasoning_effort: "low",
            sequence: 100,
            active: 1,
            enable_voice_mode: 1,
            enable_text_mode: 1,
            enable_code_execution: 1,
            enable_gesture_emotion_tools: 1,
            enable_web_search: 1,
            enable_x_search: 1,
            enable_grok_imagine_tools: 1,
            enable_memory_tools: 1,
            enable_delegate_tool: 1,
            enable_multi_agent_delegation: 0,
            enable_local_tasks: 0,
            enable_call_agents_tool: 1,
            when_to_call_description: "",
            enable_end_call_tool: 1,
            wake_phrase: "",
            wake_action: "resume_last",
            core_memory_cap: 100,
        });
    };

    const restorePresets = async () => {
        try {
            const r = await rpc("/api/agents/restore_presets", {});
            notification.add(
                r.restored?.length
                    ? _t("Restored: %s.", r.restored.join(", "))
                    : _t("All preset companions are already present."),
                { type: "info" },
            );
            load();
        } catch (e) {
            notification.add(e?.message || _t("Restore failed"), { type: "danger" });
        }
    };

    const duplicateAgent = async (a) => {
        try {
            const r = await rpc("/api/agents/duplicate", { id: a.id });
            notification.add(_t("%s created.", r.name), { type: "info" });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Duplicate failed"), { type: "danger" });
        }
    };

    const deleteAgent = async (a) => {
        if (!window.confirm(
            _t("Delete %s? This permanently removes the companion plus all its sessions, transcripts and memories.", a.name),
        )) return;
        try {
            await rpc("/api/agents/delete", { id: a.id });
            notification.add(_t("%s deleted.", a.name), { type: "info" });
            if (editingAgent?.id === a.id) setEditingAgent(null);
            load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const saveAgent = async () => {
        if (!editingAgent) return;
        setSaving(true);
        try {
            await rpc("/api/agents/save", editingAgent);
            notification.add(_t("%s saved.", editingAgent.name), { type: "info" });
            setEditingAgent(null);
            load();
        } catch (e) {
            notification.add(e?.message || "Save failed", { type: "danger" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3 style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span><i className="fa fa-users" /> {_t("Companions")}</span>
                        <span style={{ display: "flex", gap: "0.5rem" }}>
                            <button className="btn btn-sm" onClick={restorePresets}
                                    title={_t("Re-create any deleted preset companions (Eve, Ara, Rex, Sal, Leo) with their original prompts. Existing companions are untouched.")}>
                                <i className="fa fa-undo" /> {_t("Restore presets")}
                            </button>
                            <button className="btn btn-sm btn-primary" onClick={newCompanion}>
                                <i className="fa fa-plus" /> {_t("New companion")}
                            </button>
                        </span>
                    </h3>
                    {editingAgent && editingAgent.id == null && (
                        <div className="rx_agent_editor">
                            <AgentEditorFields editingAgent={editingAgent} setEditingAgent={setEditingAgent}
                                               avatars={avatars} saving={saving} saveAgent={saveAgent}
                                               cancel={() => setEditingAgent(null)} />
                        </div>
                    )}
                    {agents.map((a) => (
                        editingAgent?.id === a.id ? (
                            <div key={a.id} className="rx_agent_editor">
                                <AgentEditorFields editingAgent={editingAgent} setEditingAgent={setEditingAgent}
                                                   avatars={avatars} saving={saving} saveAgent={saveAgent}
                                                   cancel={() => setEditingAgent(null)} />
                            </div>
                        ) : (
                            <div key={a.id} className="rx_memory_row">
                                <strong>{a.name}</strong>
                                <span className="text-muted small">{_t("voice:")} {a.voice}</span>
                                <span className="rx_memory_meta">
                                    {a.enable_voice_mode ? "voice" : ""} {a.enable_text_mode ? "text" : ""}
                                </span>
                                <button className="btn btn-sm btn-link p-0" onClick={() => setEditingAgent({ ...a })}>
                                    {_t("Edit")}
                                </button>
                                <button className="btn btn-sm btn-link p-0"
                                        title={_t("Duplicate companion (settings and prompt only — history and memories stay with the original)")}
                                        onClick={() => duplicateAgent(a)}>
                                    <i className="fa fa-clone" />
                                </button>
                                <button className="btn btn-sm btn-link p-0" title={_t("Delete companion")}
                                        onClick={() => deleteAgent(a)}>
                                    <i className="fa fa-trash-o" />
                                </button>
                            </div>
                        )
                    ))}
                </section>
            </div>
        </div>
    );
}

/** Shared form body for both "edit companion" and "new companion". Controlled
 *  entirely by the parent's editingAgent state. */
function AgentEditorFields({ editingAgent, setEditingAgent, avatars, saving, saveAgent, cancel }) {
    const idScope = editingAgent.id ?? "new";
    return (
        <>
            <div className="rx_row">
                <div>
                    <label>{_t("Name")}</label>
                    <input type="text" value={editingAgent.name || ""}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, name: ev.target.value })} />
                </div>
                <div>
                    <label>{_t("Voice (built-in name or custom xAI voice id)")}</label>
                    <input type="text" value={editingAgent.voice || ""}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, voice: ev.target.value })} />
                </div>
                <div>
                    <label>{_t("Avatar")}</label>
                    <select value={editingAgent.avatar_id ?? ""}
                            onChange={(ev) => setEditingAgent({ ...editingAgent, avatar_id: parseInt(ev.target.value, 10) || null })}>
                        <option value="">{_t("(no avatar)")}</option>
                        {avatars.map((av) => (
                            <option key={av.id} value={av.id}>
                                {av.name}{av.outfit_count ? ` (${av.outfit_count} ${_t("outfits")})` : ""}
                            </option>
                        ))}
                    </select>
                </div>
                <div>
                    <label>{_t("Reasoning effort (text mode)")}</label>
                    <select value={editingAgent.reasoning_effort || "low"}
                            onChange={(ev) => setEditingAgent({ ...editingAgent, reasoning_effort: ev.target.value })}>
                        <option value="none">{_t("None")}</option>
                        <option value="low">{_t("Low")}</option>
                        <option value="medium">{_t("Medium")}</option>
                        <option value="high">{_t("High")}</option>
                    </select>
                </div>
            </div>
            <label>{_t("System prompt")}</label>
            <textarea rows={24} value={editingAgent.system_prompt || ""}
                      onChange={(ev) => setEditingAgent({ ...editingAgent, system_prompt: ev.target.value })} />
            <label title={_t("Shown to OTHER companions inside their add_agent_to_call tool so they know when to bring this companion into a live group call. Leave empty and other companions only see the name.")}>
                {_t("When to call (shown to other companions for group calls)")}
            </label>
            <textarea rows={2} value={editingAgent.when_to_call_description || ""}
                      placeholder={_t("e.g. 'Sales specialist — call for pricing, quotes, or negotiation roleplay.'")}
                      onChange={(ev) => setEditingAgent({ ...editingAgent, when_to_call_description: ev.target.value })} />
            <div className="rx_row">
                <div>
                    <label title={_t("With standby listening enabled (Settings → Voice activation), saying this phrase while no call is live starts one with this companion. Keep it 2-4 words and distinctive — e.g. 'hey Eve'. Leave empty to opt this companion out.")}>
                        {_t("Wake phrase (voice activation)")}
                    </label>
                    <input type="text" value={editingAgent.wake_phrase || ""}
                           placeholder={_t("e.g. 'hey %s'", (editingAgent.name || "Eve").toLowerCase())}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, wake_phrase: ev.target.value })} />
                </div>
                <div>
                    <label>{_t("On wake phrase")}</label>
                    <select value={editingAgent.wake_action || "resume_last"}
                            onChange={(ev) => setEditingAgent({ ...editingAgent, wake_action: ev.target.value })}>
                        <option value="resume_last">{_t("Resume the last conversation")}</option>
                        <option value="start_new">{_t("Start a new conversation")}</option>
                    </select>
                </div>
            </div>
            <div className="rx_flags">
                {AGENT_FLAGS.map(([key, label]) => (
                    <span key={key} className="rx_check">
                        <input id={`flag-${idScope}-${key}`} type="checkbox"
                               checked={!!editingAgent[key]}
                               onChange={(ev) => setEditingAgent({ ...editingAgent, [key]: ev.target.checked ? 1 : 0 })} />
                        <label htmlFor={`flag-${idScope}-${key}`}>{_t(label)}</label>
                    </span>
                ))}
            </div>
            {editingAgent.id != null && <McpConnections agentId={editingAgent.id} />}
            {editingAgent.id == null && (
                <p className="text-muted small" style={{ marginTop: "0.6rem" }}>
                    {_t("Remote MCP connections can be added after the companion is saved.")}
                </p>
            )}
            <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
                <button className="btn btn-primary btn-sm" disabled={saving} onClick={saveAgent}>
                    {_t("Save")}
                </button>
                <button className="btn btn-sm" onClick={cancel}>{_t("Cancel")}</button>
            </div>
        </>
    );
}

const EMPTY_MCP = {
    id: null,
    server_label: "",
    server_url: "",
    server_description: "",
    allowed_tools: "",
    authorization: "",
    headers: "",
    enable_for_voice: 1,
    enable_for_text: 1,
    active: 1,
};

/** Remote MCP connections for one companion. Saved independently of the
 *  agent form (separate rows, immediate persistence). xAI's servers dial the
 *  configured URL directly, so it must be publicly reachable over HTTPS. */
function McpConnections({ agentId }) {
    const [conns, setConns] = useState([]);
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        try {
            setConns(await rpc("/api/mcp/list", { agent_id: agentId }));
        } catch (e) {
            notification.add(e?.message || _t("Could not load MCP connections"), { type: "danger" });
        }
    };
    useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [agentId]);

    const save = async () => {
        setBusy(true);
        try {
            await rpc("/api/mcp/save", { ...editing, agent_id: agentId });
            setEditing(null);
            load();
        } catch (e) {
            notification.add(e?.message || "Save failed", { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const remove = async (c) => {
        if (!window.confirm(_t("Remove MCP connection %s?", c.server_label))) return;
        try {
            await rpc("/api/mcp/delete", { id: c.id });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const set = (key, value) => setEditing((c) => ({ ...c, [key]: value }));

    return (
        <div style={{ marginTop: "0.85rem" }}>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{_t("Remote MCP connections")}</span>
                <button className="btn btn-sm" onClick={() => setEditing({ ...EMPTY_MCP })}>
                    <i className="fa fa-plus" /> {_t("Add connection")}
                </button>
            </label>
            {!conns.length && !editing && (
                <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                    {_t("None configured. An MCP server gives this companion extra tools; xAI connects to it directly, so the URL must be public HTTPS.")}
                </p>
            )}
            {conns.map((c) => (
                <div key={c.id} className="rx_memory_row">
                    <strong>{c.server_label}</strong>
                    <span className="rx_memory_content text-muted small">{c.server_url}</span>
                    <span className="rx_memory_meta">
                        {c.active ? "" : "inactive · "}
                        {c.enable_for_voice ? "voice " : ""}{c.enable_for_text ? "text" : ""}
                        {c.has_authorization ? " · 🔑" : ""}
                    </span>
                    <button className="btn btn-sm btn-link p-0"
                            onClick={() => setEditing({ ...c, authorization: "" })}>
                        {_t("Edit")}
                    </button>
                    <button className="btn btn-sm btn-link p-0" title={_t("Remove")} onClick={() => remove(c)}>
                        <i className="fa fa-trash-o" />
                    </button>
                </div>
            ))}
            {editing && (
                <div className="rx_agent_editor" style={{ marginTop: "0.5rem" }}>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Server label (a-z, 0-9, _ — shown to the model)")}</label>
                            <input type="text" value={editing.server_label}
                                   onChange={(ev) => set("server_label", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Server URL (public https://)")}</label>
                            <input type="text" placeholder="https://mcp.example.com/mcp"
                                   value={editing.server_url}
                                   onChange={(ev) => set("server_url", ev.target.value)} />
                        </div>
                    </div>
                    <label>{_t("Description (hint to the model about when to use this server)")}</label>
                    <input type="text" value={editing.server_description || ""}
                           onChange={(ev) => set("server_description", ev.target.value)} />
                    <div className="rx_row">
                        <div>
                            <label>{_t("Bearer token")} {editing.id && editing.has_authorization ? _t("(saved — blank keeps it)") : _t("(optional)")}</label>
                            <input type="password" value={editing.authorization || ""}
                                   onChange={(ev) => set("authorization", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Extra headers (JSON object, optional)")}</label>
                            <input type="text" placeholder='{"X-Tenant": "acme"}'
                                   value={editing.headers || ""}
                                   onChange={(ev) => set("headers", ev.target.value)} />
                        </div>
                    </div>
                    <label>{_t("Allowed tools (one per line — blank allows all)")}</label>
                    <textarea rows={3} value={editing.allowed_tools || ""}
                              onChange={(ev) => set("allowed_tools", ev.target.value)} />
                    <div className="rx_flags">
                        {[["enable_for_voice", "Voice sessions"],
                          ["enable_for_text", "Text sessions"],
                          ["active", "Active"]].map(([key, label]) => (
                            <span key={key} className="rx_check">
                                <input id={`mcp-${editing.id ?? "new"}-${key}`} type="checkbox"
                                       checked={!!editing[key]}
                                       onChange={(ev) => set(key, ev.target.checked ? 1 : 0)} />
                                <label htmlFor={`mcp-${editing.id ?? "new"}-${key}`}>{_t(label)}</label>
                            </span>
                        ))}
                    </div>
                    <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.5rem" }}>
                        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{_t("Save connection")}</button>
                        <button className="btn btn-sm" onClick={() => setEditing(null)}>{_t("Cancel")}</button>
                    </div>
                </div>
            )}
        </div>
    );
}
