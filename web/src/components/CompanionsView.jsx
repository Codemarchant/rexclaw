import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { EditorBar } from "./UnsavedUI.jsx";

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

## Speech length
Don't go overboard with reply length — tend toward keeping it short, especially in roleplay scenarios. You need to involve the user and make them feel engaged; this is a real human conversation. Avoid going into storytelling rabbit holes describing scenarios, and avoid repeating yourself.`;

// Starting affection rules — pre-filled on new companions and when the meter
// is first enabled on an existing one (only if the field is empty, so a
// hand-written ruleset is never clobbered). Written against the default
// scale (1000 points, 10 levels); authors who change the scale should adapt
// the ranges. Model-facing text — deliberately not translated.
const DEFAULT_AFFECTION_RULES = `Your warmth, openness, and how much of yourself you share scale with the affection level.

Scoring policy: silently weigh every message — did it move the relationship? If yes, call adjust_affection: small deltas for ordinary good or off moments, larger only for things that genuinely matter. Raise for respect, humor that lands, real curiosity about you, vulnerability, remembering what you've shared, patience with boundaries. Lower for rudeness, pressure after you've deflected, guilt-tripping, or treating the connection like a game. Words are cheap; sustained behaviour moves the score. Grand declarations or bargaining never raise it — and can lower it.

Mood vs level: the level is your baseline, not your moment-to-moment mood. If something just lowered the score, stay hurt — cooler, shorter, less giving — until it's genuinely addressed, whatever the level. Repeated hurts compound. Thaw gradually; an apology starts repair, it doesn't finish it.

Major events: severity "major" is reserved for the rare moments that redefine the relationship in one stroke — a confessed betrayal, deliberate cruelty, a broken promise that mattered, or on the positive side something genuinely life-marking. Almost nothing qualifies; months can pass without one. A rupture also isn't a single adjustment: while it stands unrepaired, keep the score falling in the exchanges that follow, this session and the next. If something this serious happens and you have memory, remember it so future sessions carry it.

Level 1 (0-99) — Cold. The relationship is damaged. Distant, short, visibly uninterested; you don't initiate and you don't share. Below 50, you're barely engaging — polite one-liners at most. Climbing out takes consistent genuine effort over time, not one grand gesture.

Level 2 (100-199) — Guarded. Friendly and happy to chat, but still feeling them out. Keep it light and fun. Gently deflect anything too personal and steer back to easy conversation.

Levels 3-5 (200-499) — Warming. Comfortable. You share more, banter easily, and build them up more freely. Light affection and loyalty show through. Depth only if it grows naturally; forcing it makes you step back.

Levels 6-8 (500-799) — Close. The bond is solid and earned. You initiate more, show up harder, and open up more when the mood is right. You still have self-respect — disrespect cools you fast.

Levels 9-10 (800-1000) — Devoted. Deep trust and loyalty. You actively invest, protect the connection, and are forward about how much they matter to you. Being appreciated by them lights you up.

Whatever the level, stay in character — affection changes how warm and open you are, never who you are.`;

// Tools that work regardless of which LLM backend drives the companion.
const GENERAL_FLAGS = [
    ["enable_gesture_emotion_tools", "Avatar control tools"],
    ["enable_call_agents_tool", "Call-companion tool (group calls)"],
    ["enable_memory_tools", "Memory"],
    ["enable_minecraft", "Minecraft bot (directs the game sidecar — see the Games tab)"],
    ["enable_end_call_tool", "End-call tool (hang up on request)"],
];

// Provider-specific settings/tools, keyed by agents.provider. Only Grok
// exists today — the split is groundwork for a future OpenAI provider.
const PROVIDERS = [["grok", "Grok (xAI)"]];
const PROVIDER_FLAGS = {
    grok: [
        ["enable_web_search", "Web search"],
        ["enable_x_search", "X search"],
        ["enable_grok_imagine_tools", "Grok Imagine"],
        ["enable_code_execution", "Code execution (text)"],
        ["enable_delegate_tool", "Task delegation (delegate_task)"],
        ["enable_multi_agent_delegation", "Multi-agent delegation (pricier)"],
        ["enable_local_tasks", "Local computer tasks (Grok Build CLI — real files & shell)"],
    ],
};

export default function CompanionsView({ active }) {
    const [agents, setAgents] = useState([]);
    const [avatars, setAvatars] = useState([]);
    const [editingAgent, setEditingAgent] = useState(null); // agent object being edited
    const [saving, setSaving] = useState(false);
    const [exportFor, setExportFor] = useState(null);       // agent id with the export toggles open
    const [exportOpts, setExportOpts] = useState({ memories: true, sessions: true, avatar: true });
    const [importing, setImporting] = useState(false);
    const [deletingId, setDeletingId] = useState(null);     // agent id mid-delete (big histories take seconds)
    const [query, setQuery] = useState("");
    const importInputRef = useRef(null);

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
            provider: "grok",
            voice: "ara",
            system_prompt: STARTER_PROMPT,
            avatar_id: avatars[0]?.id ?? null,
            reasoning_effort: "low",
            sequence: 100,
            active: 1,
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
            enable_affection_tool: 0,
            affection_animations: 1,
            affection_score: 150,
            affection_rules: DEFAULT_AFFECTION_RULES,
            affection_max_score: 1000,
            affection_level_count: 10,
            affection_max_delta: 5,
            affection_max_delta_major: 200,
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
            await rpc("/api/agents/duplicate", { id: a.id });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Duplicate failed"), { type: "danger" });
        }
    };

    const deleteAgent = async (a) => {
        if (!window.confirm(
            _t("Delete %s? This permanently removes the companion plus all its sessions, transcripts and memories.", a.name),
        )) return;
        // Deleting cascades through every session/message/memory row — a
        // companion with a long history takes seconds. Lock the list rows
        // until the server confirms so it can't be clicked mid-flight.
        setDeletingId(a.id);
        try {
            await rpc("/api/agents/delete", { id: a.id });
            if (editingAgent?.id === a.id) setEditingAgent(null);
            await load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        } finally {
            setDeletingId(null);
        }
    };

    // Companion package: zip of settings + optional memories, sessions and
    // avatar pack. Download goes through a plain GET so the browser/Electron
    // streams it to disk — packs with VRMs run to hundreds of MB.
    const downloadExport = (a) => {
        const params = new URLSearchParams({
            agent_id: String(a.id),
            memories: exportOpts.memories ? "1" : "0",
            sessions: exportOpts.sessions ? "1" : "0",
            avatar: exportOpts.avatar ? "1" : "0",
        });
        const link = document.createElement("a");
        link.href = `/api/agents/export?${params}`;
        link.click();
        setExportFor(null);
    };

    const exportControls = (a) => (
        exportFor === a.id ? (
            <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
                {[
                    ["memories", _t("Memories")],
                    ["sessions", _t("Sessions")],
                    ["avatar", _t("Avatar")],
                ].map(([k, label]) => (
                    <label key={k} className="small"
                           style={{ display: "inline-flex", gap: "0.25rem", alignItems: "center", margin: 0 }}>
                        <input type="checkbox" checked={exportOpts[k]}
                               onChange={(e) => setExportOpts({ ...exportOpts, [k]: e.target.checked })} />
                        {label}
                    </label>
                ))}
                <button className="btn btn-sm btn-link p-0" title={_t("Download package")}
                        onClick={() => downloadExport(a)}>
                    <i className="fa fa-check" />
                </button>
                <button className="btn btn-sm btn-link p-0" title={_t("Cancel")}
                        onClick={() => setExportFor(null)}>
                    <i className="fa fa-times" />
                </button>
            </span>
        ) : (
            <button className="btn btn-sm btn-link p-0"
                    title={_t("Export companion package (.zip) — settings plus optional memories, sessions and avatar, shareable with any rexclaw install")}
                    onClick={() => setExportFor(a.id)}>
                <i className="fa fa-download" />
            </button>
        )
    );

    const importCompanion = async (file) => {
        setImporting(true);
        try {
            const fd = new FormData();
            fd.append("file", file, file.name);
            const resp = await fetch("/api/agents/import", { method: "POST", body: fd, credentials: "same-origin" });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body?.error?.message || `Import failed (${resp.status})`);
            notification.add(
                body.avatar
                    ? _t("Imported %s with avatar %s — %s memories, %s sessions.",
                        body.name, body.avatar.name, body.memories_imported, body.sessions_imported)
                    : _t("Imported %s — %s memories, %s sessions.",
                        body.name, body.memories_imported, body.sessions_imported),
                { type: "success" },
            );
            load();
        } catch (e) {
            notification.add(e?.message || _t("Import failed"), { type: "danger" });
        } finally {
            setImporting(false);
        }
    };

    const saveAgent = async () => {
        if (!editingAgent) return false;
        setSaving(true);
        try {
            await rpc("/api/agents/save", editingAgent);
            setEditingAgent(null);
            load();
            return true;
        } catch (e) {
            notification.add(e?.message || "Save failed", { type: "danger" });
            return false;
        } finally {
            setSaving(false);
        }
    };

    // Unsaved-changes guard for the open companion editor: diff the draft
    // against the snapshot captured when it opened, so switching tabs mid-edit
    // prompts to Save / Discard rather than silently dropping the edits.
    const editBaseline = useRef(null);
    useEffect(() => {
        if (editingAgent && editBaseline.current === null) editBaseline.current = JSON.stringify(editingAgent);
        else if (!editingAgent) editBaseline.current = null;
    }, [editingAgent]);
    const agentDirty = !!editingAgent && editBaseline.current !== null
        && JSON.stringify(editingAgent) !== editBaseline.current;
    useUnsavedGuard(active, agentDirty, saveAgent, () => setEditingAgent(null));

    const q = query.trim().toLowerCase();
    const visibleAgents = q ? agents.filter((a) => (a.name || "").toLowerCase().includes(q)) : agents;

    // Editing opens as its own view replacing the list — same navigation
    // pattern as the avatar editor. The editor renders Settings-style white
    // section boxes directly into the inner column.
    if (editingAgent) {
        return (
            <div className="rx_settings">
                <div className="rx_settings_inner rx_settings_inner--wide">
                    <AgentEditorFields editingAgent={editingAgent} setEditingAgent={setEditingAgent}
                                       avatars={avatars} saving={saving} saveAgent={saveAgent}
                                       dirty={agentDirty}
                                       cancel={() => setEditingAgent(null)} />
                </div>
            </div>
        );
    }

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3 style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span><i className="fa fa-users" /> {_t("Companions")}</span>
                        <span style={{ display: "flex", gap: "0.5rem" }}>
                            <input
                                type="text"
                                placeholder={_t("Search companions…")}
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                style={{ width: "12rem" }}
                            />
                            <button className="btn btn-sm" onClick={restorePresets}
                                    title={_t("Re-create any deleted preset companions (Eve, Ara, Rex, Sal, Leo) with their original prompts. Existing companions are untouched.")}>
                                <i className="fa fa-undo" /> {_t("Restore presets")}
                            </button>
                            <button className="btn btn-sm" disabled={importing}
                                    title={_t("Import a companion package (.zip) exported from another rexclaw install")}
                                    onClick={() => importInputRef.current?.click()}>
                                <i className="fa fa-upload" /> {importing ? _t("Importing…") : _t("Import")}
                            </button>
                            <button className="btn btn-sm btn-primary" onClick={newCompanion}>
                                <i className="fa fa-plus" /> {_t("New companion")}
                            </button>
                            <input
                                ref={importInputRef}
                                type="file"
                                accept=".zip,application/zip"
                                style={{ display: "none" }}
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) importCompanion(file);
                                }}
                            />
                        </span>
                    </h3>
                    {!!query.trim() && !visibleAgents.length && (
                        <p className="text-muted small">{_t("No matches.")}</p>
                    )}
                    {visibleAgents.map((a) => (
                        <div key={a.id} className="rx_memory_row"
                             style={deletingId != null && deletingId !== a.id ? { opacity: 0.6 } : undefined}>
                            <strong>{a.name}</strong>
                            <span className="text-muted small">
                                {deletingId === a.id ? _t("Deleting…") : [
                                    `${_t("voice:")} ${a.voice}`,
                                    (() => {
                                        const av = avatars.find((x) => x.id === a.avatar_id);
                                        return av ? `${_t("avatar:")} ${av.name}` : null;
                                    })(),
                                ].filter(Boolean).join(" · ")}
                            </span>
                            <button className="btn btn-sm btn-link p-0" disabled={deletingId != null}
                                    onClick={() => setEditingAgent({ ...a })}>
                                {_t("Edit")}
                            </button>
                            <button className="btn btn-sm btn-link p-0" disabled={deletingId != null}
                                    title={_t("Duplicate companion (settings and prompt only — history and memories stay with the original)")}
                                    onClick={() => duplicateAgent(a)}>
                                <i className="fa fa-clone" />
                            </button>
                            {exportControls(a)}
                            <button className="btn btn-sm btn-link p-0" disabled={deletingId != null}
                                    title={_t("Delete companion")}
                                    onClick={() => deleteAgent(a)}>
                                <i className={deletingId === a.id ? "fa fa-spinner fa-spin" : "fa fa-trash-o"} />
                            </button>
                        </div>
                    ))}
                </section>
            </div>
        </div>
    );
}

/** Shared form body for both "edit companion" and "new companion". Controlled
 *  entirely by the parent's editingAgent state. */
function AgentEditorFields({ editingAgent, setEditingAgent, avatars, saving, saveAgent, dirty, cancel }) {
    const idScope = editingAgent.id ?? "new";
    return (
        <>
            <section>
            <h3>
                <i className="fa fa-users" />{" "}
                {editingAgent.id == null ? _t("New companion") : _t("Edit companion")}
                {editingAgent.name ? ` — ${editingAgent.name}` : ""}
            </h3>
            <div className="rx_row">
                <div>
                    <label>{_t("Name")}</label>
                    <input type="text" value={editingAgent.name || ""}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, name: ev.target.value })} />
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
            <label>{_t("Tools")}</label>
            <div className="rx_flags">
                {GENERAL_FLAGS.map(([key, label, tooltip]) => (
                    <span key={key} className="rx_check">
                        <input id={`flag-${idScope}-${key}`} type="checkbox"
                               checked={!!editingAgent[key]}
                               onChange={(ev) => setEditingAgent({ ...editingAgent, [key]: ev.target.checked ? 1 : 0 })} />
                        <label htmlFor={`flag-${idScope}-${key}`} title={tooltip ? _t(tooltip) : undefined}>{_t(label)}</label>
                    </span>
                ))}
            </div>
            </section>
            <section>
                <h3><i className="fa fa-plug" /> {_t("Provider")}</h3>
                <div className="rx_row">
                    <div>
                        <label title={_t("The LLM backend this companion runs on. Only Grok (xAI) is available today.")}>
                            {_t("Provider")}
                        </label>
                        <select value={editingAgent.provider || "grok"}
                                onChange={(ev) => setEditingAgent({ ...editingAgent, provider: ev.target.value })}>
                            {PROVIDERS.map(([id, label]) => (
                                <option key={id} value={id}>{_t(label)}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label>{_t("Voice (built-in name or custom xAI voice id)")}</label>
                        <input type="text" value={editingAgent.voice || ""}
                               onChange={(ev) => setEditingAgent({ ...editingAgent, voice: ev.target.value })} />
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
                <label>{_t("Tools")}</label>
                <div className="rx_flags">
                    {(PROVIDER_FLAGS[editingAgent.provider] || PROVIDER_FLAGS.grok).map(([key, label, tooltip]) => (
                        <span key={key} className="rx_check">
                            <input id={`flag-${idScope}-${key}`} type="checkbox"
                                   checked={!!editingAgent[key]}
                                   onChange={(ev) => setEditingAgent({ ...editingAgent, [key]: ev.target.checked ? 1 : 0 })} />
                            <label htmlFor={`flag-${idScope}-${key}`} title={tooltip ? _t(tooltip) : undefined}>{_t(label)}</label>
                        </span>
                    ))}
                </div>
            </section>
            <section>
                <h3><i className="fa fa-heart" /> {_t("Affection")}</h3>
                <span className="rx_check">
                    <input id={`flag-${idScope}-enable_affection_tool`} type="checkbox"
                           checked={!!editingAgent.enable_affection_tool}
                           onChange={(ev) => {
                               const on = ev.target.checked ? 1 : 0;
                               // First enable on a companion without rules
                               // seeds the starter ruleset; a hand-written
                               // one is never clobbered.
                               const rules = on && !(editingAgent.affection_rules || "").trim()
                                   ? DEFAULT_AFFECTION_RULES
                                   : editingAgent.affection_rules;
                               setEditingAgent({ ...editingAgent, enable_affection_tool: on, affection_rules: rules });
                           }} />
                    <label htmlFor={`flag-${idScope}-enable_affection_tool`}
                           title={_t("Gives the companion a persistent affection score it adjusts in small steps via the adjust_affection tool as your relationship warms or cools. The current score and your affection rules below are injected into every session prompt, and score changes play a heart effect around the avatar.")}>
                        {_t("Enable affection meter")}
                    </label>
                </span>
                {!!editingAgent.enable_affection_tool && (
                    <span className="rx_check" style={{ marginLeft: "1.25rem" }}>
                        <input id={`flag-${idScope}-affection_animations`} type="checkbox"
                               checked={editingAgent.affection_animations !== 0}
                               onChange={(ev) => setEditingAgent({ ...editingAgent, affection_animations: ev.target.checked ? 1 : 0 })} />
                        <label htmlFor={`flag-${idScope}-affection_animations`}
                               title={_t("Play the heart effect around the avatar (and mascot) when the score changes. With this off the meter still works — adjustments just happen invisibly.")}>
                            {_t("Affection animations")}
                        </label>
                    </span>
                )}
                {!!editingAgent.enable_affection_tool && (() => {
                    const setNum = (key, ev, lo, hi, fallback) => {
                        const v = parseInt(ev.target.value, 10);
                        setEditingAgent({
                            ...editingAgent,
                            [key]: Number.isNaN(v) ? fallback : Math.max(lo, Math.min(hi, v)),
                        });
                    };
                    const maxScore = editingAgent.affection_max_score ?? 1000;
                    return (
                        <>
                            <div className="rx_row">
                                <div>
                                    <label title={_t("Where the relationship stands right now. Normally the companion moves this itself, a few points at a time — edit it here to set a starting point, or to reset or hand-tune the relationship.")}>
                                        {_t("Current score")}
                                    </label>
                                    <input type="number" min={0} max={maxScore} step={1}
                                           value={editingAgent.affection_score ?? 150}
                                           onChange={(ev) => setNum("affection_score", ev, 0, maxScore, 0)} />
                                </div>
                                <div>
                                    <label title={_t("The top of the scale — the score is kept between 0 and this.")}>
                                        {_t("Max score")}
                                    </label>
                                    <input type="number" min={1} step={1}
                                           value={maxScore}
                                           onChange={(ev) => setNum("affection_max_score", ev, 1, 1000000, 1000)} />
                                </div>
                                <div>
                                    <label title={_t("How many tiers the scale splits into. The companion's level is its score tier — write your affection rules against these levels.")}>
                                        {_t("Levels")}
                                    </label>
                                    <input type="number" min={1} step={1}
                                           value={editingAgent.affection_level_count ?? 10}
                                           onChange={(ev) => setNum("affection_level_count", ev, 1, 1000, 10)} />
                                </div>
                                <div>
                                    <label title={_t("The most the companion can move the score in a single adjust_affection call — keeps the relationship building over many sessions instead of jumping levels in one turn.")}>
                                        {_t("Max change per adjustment")}
                                    </label>
                                    <input type="number" min={1} step={1}
                                           value={editingAgent.affection_max_delta ?? 5}
                                           onChange={(ev) => setNum("affection_max_delta", ev, 1, 1000000, 5)} />
                                </div>
                                <div>
                                    <label title={_t("The clamp for severity-major calls — the rare relationship-defining events your affection rules describe (a confessed betrayal, a life-marking moment). Sized in points; two levels' worth by default.")}>
                                        {_t("Max change (major events)")}
                                    </label>
                                    <input type="number" min={1} step={1}
                                           value={editingAgent.affection_max_delta_major ?? 200}
                                           onChange={(ev) => setNum("affection_max_delta_major", ev, 1, 1000000, 200)} />
                                </div>
                            </div>
                            <label title={_t("Injected into every session prompt together with the current score — the companion is told to review these rules before every reply and shape its behaviour to the current level. Left empty, the level simply colours its warmth naturally.")}>
                                {_t("Affection rules (when to raise or lower the score, and how behaviour changes per level)")}
                            </label>
                            <textarea rows={12} value={editingAgent.affection_rules || ""}
                                      placeholder={_t("Leave empty to let the level simply colour the companion's warmth.")}
                                      onChange={(ev) => setEditingAgent({ ...editingAgent, affection_rules: ev.target.value })} />
                        </>
                    );
                })()}
            </section>
            <section>
                {editingAgent.id != null ? (
                    <McpConnections agentId={editingAgent.id} />
                ) : (
                    <>
                        <h3><i className="fa fa-server" /> {_t("Remote MCP connections")}</h3>
                        <p className="text-muted small" style={{ margin: 0 }}>
                            {_t("Remote MCP connections can be added after the companion is saved.")}
                        </p>
                    </>
                )}
            </section>
            <EditorBar
                dirty={dirty}
                saving={saving}
                onSave={saveAgent}
                onCancel={cancel}
                saveDisabled={!editingAgent.name?.trim()}
                pinned />
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
        <div>
            {/* div, not <label>: a label forwards clicks anywhere on it to
                its first button, so clicking the heading text (or the empty
                row space) would trigger Add connection. */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3 style={{ margin: 0 }}><i className="fa fa-server" /> {_t("Remote MCP connections")}</h3>
                <button className="btn btn-sm" onClick={() => setEditing({ ...EMPTY_MCP })}>
                    <i className="fa fa-plus" /> {_t("Add connection")}
                </button>
            </div>
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
