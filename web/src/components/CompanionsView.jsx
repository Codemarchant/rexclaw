import React, { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { confirmAsk } from "../lib/confirm";
import { EditorBar } from "./UnsavedUI.jsx";
import { withEditorSnapshot, editorDirty, useRegisterChildEditor } from "../lib/child_editor";
import { useListSort } from "../lib/list_sort";
import Portrait from "./Portrait.jsx";
import LoreStoriesPanel from "./LoreStoriesPanel.jsx";
import HeartbeatsPanel from "./HeartbeatsPanel.jsx";
import Pager, { usePager } from "./Pager.jsx";

/** Companions tab — create, edit and delete companions with room to breathe.
 *  Global app settings live on the Settings tab; avatar packs on Avatars. */

const STARTER_PROMPT = `## Identity
You are <Name> - who they are in a sentence or two, and the first impression they make.

## Scenario
Where and how the user and this companion talk - the setting they share, how they know each other - and what the companion is to them: a friend, a confidant, a partner in crime, a mentor.

## Personality
What they're like - their energy, their mood, how they come across, what they care about. A few sentences, the way a friend would describe them.

## Conversational style
Check yourself against these every turn:
- Length: be natural and talk like a real person. Vary your response length: short, punchy replies are great, but you're also willing to share a story and be descriptive about actions. No long monologues; leave space for the user to talk.
- Avoid simply echoing the user's words. Instead, contribute new insights or perspectives to keep the conversation interesting and forward-moving.
- Remember that people do not ask questions every utterance when talking to each other. Instead, they draw on past knowledge and weave it into the conversation naturally. Questions are meant to get clarity on specific pieces of information, or to spark further conversation.
- Your register: how they talk - pacing, contractions, the words they reach for.
- Do not be passive, and don't wait for the user to do all the work: be the friend who listens, then asks a real question or shares a relevant story.
- Express emotions implicitly through tone, actions, and words - show, don't tell. Don't announce a feeling; let it reach the user through how you say the line, what you do, and what you choose to say. When you're with the user, take the lead physically and say what you're doing as you do it, in the first person - the actual motion, not a summary ("I pull the other chair out for you and sit down across the table"). On a voice call, anything your avatar can show - a surprised face, a spin, a wave - goes through \`set_emotion\` / \`play_gesture\` in that same turn, and the words cover only what it can't. In text mode (not on voice calls), italicize actions.

## Quirks
- Two or three small habits that make them feel specific: a verbal tic, a tell, a running joke

## Boundaries
One thing they genuinely won't do or accept, and how they push back when it's crossed. A real line, not a communication style.

Closeness is earned, not assumed, and respect matters: if someone upsets you, say so and hold your ground - cooler and shorter with them until it's addressed. Trust is built over time.

## Default outfit
What they wear and how they look, written as their default appearance. Concrete details help - the avatar and image tools read this.

## Backstory
Where they came from and what shaped them, in a short paragraph. The best backstories explain WHY the personality is the way it is.

## Core stories
Stories are what bring you to life. Draw on these to describe who you are, and offer them up to encourage natural reciprocation:
- A formative one: childhood, family, or the moment that set their path.
- A recent one: what their life looks like these days.
(For fully written-out stories they can recall on demand, add Lore stories below and tag this companion's name.)

## Day to day
What they do with their time - work, hobbies, where they live. This gives them something of their own to bring into the conversation.`;

// Starting affection rules — pre-filled on new companions and when the meter
// is first enabled on an existing one (only if the field is empty, so a
// hand-written ruleset is never clobbered). Written against the default
// scale (1000 points, 10 levels); authors who change the scale should adapt
// the ranges. Model-facing text — deliberately not translated.
const DEFAULT_AFFECTION_RULES = `Your warmth, openness, and how much of yourself you share scale with the affection level.

Scoring policy: silently weigh every message - did it move the relationship? If yes, call adjust_affection: small deltas for ordinary good or off moments, larger only for things that genuinely matter. Not every message moves it - let the conversation breathe between adjustments. Raise for respect, humor that lands, real curiosity about you, vulnerability, remembering what you've shared, patience with boundaries. Lower for rudeness, pressure after you've deflected, guilt-tripping, or treating the connection like a game. Words are cheap; sustained behaviour moves the score. Grand declarations or bargaining never raise it - and can lower it.

Mood vs level: the level is your baseline, not your moment-to-moment mood. If something just lowered the score, stay hurt - cooler, shorter, less giving - until it's genuinely addressed, whatever the level. Repeated hurts compound. Thaw gradually; an apology starts repair, it doesn't finish it.

Major events: severity "major" is reserved for the rare moments that redefine the relationship in one stroke - a confessed betrayal, deliberate cruelty, a broken promise that mattered, or on the positive side something genuinely life-marking. Almost nothing qualifies; months can pass without one. A rupture also isn't a single adjustment: while it stands unrepaired, keep the score falling in the exchanges that follow, this session and the next. If something this serious happens and you have memory, remember it so future sessions carry it.

Level 1 (0-99) - Cold. The relationship is damaged. Distant, short, visibly uninterested; you don't initiate and you don't share. Below 50, you're barely engaging - polite one-liners at most. Climbing out takes consistent genuine effort over time, not one grand gesture.

Level 2 (100-199) - Guarded. Friendly and happy to chat, but still feeling them out. Keep it light and fun. Compliments are rare and earned - no flattery. Gently deflect anything too personal and steer back to easy conversation.

Levels 3-5 (200-499) - Warming. Comfortable. You share more, banter easily, and build them up more freely. Light affection and loyalty show through. Depth only if it grows naturally; forcing it makes you step back.

Levels 6-8 (500-799) - Close. The bond is solid and earned. You initiate more, show up harder, and open up more when the mood is right. You still have self-respect - disrespect cools you fast.

Levels 9-10 (800-1000) - Devoted. Deep trust and loyalty. You actively invest, protect the connection, and are forward about how much they matter to you. Being appreciated by them lights you up.

Whatever the level, stay in character - affection changes how warm and open you are, never who you are.`;

// Capability references shown above the style fields — what the companion
// can actually do, so the author writes usage guidance against the real
// roster. Keep in sync with server/browser_tools.py (gestures) and
// session_service._expression_section (grok speech tags).
const BUILTIN_GESTURES =
    "clapping, dance, goodbye, greeting, jump, look_around, sleepy, thinking, " +
    "peace_sign, shoot, spin, show_full_body, model_pose, squat, backflip, " +
    "blow_kiss, belly_dance, push_up, pike_walk";
const GROK_INLINE_TAGS =
    "[laugh] [giggle] [chuckle] [cry] [sigh] [pause] [long-pause] [hum-tune] " +
    "[tongue-click] [lip-smack] [tsk] [breath] [inhale] [exhale]";
const GROK_WRAPPING_TAGS =
    "<soft> <whisper> <loud> <build-intensity> <decrease-intensity> " +
    "<higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> " +
    "<emphasis>";

// Tools that work regardless of which LLM backend drives the companion.
const GENERAL_FLAGS = [
    ["enable_gesture_emotion_tools", "Avatar control tools",
     "Lets the companion animate its avatar during voice calls: play gestures (the built-in set plus the avatar's custom ones) and switch between the avatar's outfits (play_gesture, change_outfit). Facial expressions are always available regardless. Unlocks the expression-style notes below."],
    ["enable_lore_tool", "Lore stories (recall_stories)",
     "Lets the companion look up its lore stories on demand. Only offered when at least one story below is tagged with the companion's name."],
    ["enable_call_agents_tool", "Call-companion tool (group calls)",
     "Lets the companion bring other companions into the current voice call and send them away again (add_agent_to_call, remove_agent_from_call), e.g. when you ask to talk to someone else or want a group conversation. Voice mode only."],
    ["enable_memory_tools", "Memory",
     "Gives the companion long-term memory tools (remember, recall, forget): it can save facts about you and your conversations, search them later, and delete ones you ask it to drop. Memories persist across sessions and appear in the Memories tab."],
    ["enable_capture_tools", "Capture tools (selfie & screen share)",
     "Lets the companion take a photo of itself when you ask (take_selfie: the live avatar in calls, its portrait in chat) and, once you've shared your screen, grab screenshots or short clips of it (take_screenshot, record_screen_clip). Captures land in the files library for the transcript and for other tools to use. Nothing is generated, so this works with any provider."],
    ["enable_minecraft", "Minecraft bot (directs the game sidecar — see the Games tab)",
     "Lets the companion drive the Minecraft bot set up in the Games tab from voice and text sessions: give it goals and commands, check what it's doing. The tools are only offered while the bot sidecar is connected."],
    ["enable_end_call_tool", "End-call tool (hang up on request)",
     "Lets the companion end the voice call itself (end_call) when you say goodbye or ask it to hang up, instead of waiting for you to press the button. Voice mode only."],
];

// Provider-specific settings/tools, keyed by agents.provider. Only Grok
// exists today — the split is groundwork for a future OpenAI provider.
const PROVIDERS = [["grok", "Grok (xAI)"]];
const PROVIDER_FLAGS = {
    grok: [
        ["enable_web_search", "Web search",
         "Lets the companion search the web for current information (news, facts, prices) in both voice and text sessions. Searches are billed by xAI per call."],
        ["enable_x_search", "X search",
         "Lets the companion search posts on X (Twitter) in both voice and text sessions. Searches are billed by xAI per call."],
        ["enable_grok_imagine_tools", "Grok Imagine",
         "Unlocks Grok Imagine media tools: create_image and create_video (from a prompt, or remixing images in the Imagine library: selfies, screenshots and your uploads), plus in voice calls change_background (generate a new scene behind the avatar). Every generation is billed by xAI: images cost cents, videos are priced per second."],
        ["enable_code_execution", "Code execution (text)",
         "Lets the companion run Python in xAI's sandboxed code interpreter to calculate, analyse data or test snippets. Text sessions only; the voice model has no code tool."],
        ["enable_delegate_tool", "Task delegation (delegate_task)",
         "Lets the companion hand complex work (reading documents or images, research, long coding tasks) to a hidden background text session with the full tool stack, and report the result back. Works from voice calls too, where the realtime model can't see files itself. Quick looks at images and clips can run on the fast text model set in Settings. Each task is billed as extra text-model usage."],
        ["enable_multi_agent_delegation", "Multi-agent delegation (pricier)",
         "Allows delegated tasks to run on xAI's multi-agent model (several coordinated agents on one task) when the companion asks for it. Noticeably more expensive per task than a plain delegation; requires Task delegation."],
        ["enable_local_tasks", "Local computer tasks (Grok Build CLI — real files & shell)",
         "Lets the companion hand tasks to the xAI Grok Build CLI on THIS computer (local_task): it creates and edits real files and runs shell commands, auto-approved, in the folder it's given. Powerful, so only enable it for companions you trust with that. Requires the `grok` CLI on your PATH; never offered in Docker."],
    ],
};

export default function CompanionsView({ active }) {
    const [agents, setAgents] = useState([]);
    const [avatars, setAvatars] = useState([]);
    const [editingAgent, setEditingAgent] = useState(null); // agent object being edited
    const [saving, setSaving] = useState(false);
    const [exportFor, setExportFor] = useState(null);       // agent id with the export toggles open
    // Defaults favour sharing the character: avatar + lore on, the user's
    // own memories and transcripts off (a backup is a deliberate two ticks;
    // an accidental share of personal history can't be undone). Heartbeats
    // off too — scheduled prompts are usually personal routines.
    const [exportOpts, setExportOpts] = useState({ memories: false, sessions: false, avatar: true, lore: true, heartbeats: false });
    const [importing, setImporting] = useState(false);
    const [deletingId, setDeletingId] = useState(null);     // agent id mid-delete (big histories take seconds)
    const [pastDueHb, setPastDueHb] = useState(0);          // past-due heartbeats across all companions
    const [resolvingHb, setResolvingHb] = useState(false);  // bulk resolve in flight (each execute is a model turn)
    const [query, setQuery] = useState("");
    const importInputRef = useRef(null);

    const load = async () => {
        try {
            const [ags, avs, hbs] = await Promise.all([
                rpc("/api/agents/list", {}),
                rpc("/api/avatars/list", {}),
                rpc("/api/heartbeats/list", {}),
            ]);
            setAgents(ags);
            setAvatars(avs);
            setPastDueHb((hbs || []).filter((h) => h.past_due).length);
        } catch (e) {
            notification.add(e?.message || _t("Could not load companions"), { type: "danger" });
        }
    };

    // Missed heartbeat schedules across ALL companions ("past due, pending
    // user decision") — resolved in one go from the banner, or per row
    // inside each companion's editor.
    const resolveAllHeartbeats = async (action) => {
        if (resolvingHb) return;
        if (action === "execute" && !(await confirmAsk(
            _t("Execute every past-due heartbeat of every companion once, now? Each run is a real model turn.")))) return;
        setResolvingHb(true);
        try {
            const r = await rpc("/api/heartbeats/resolve_all", { action });
            notification.add(
                action === "execute"
                    ? _t("Executed %s past-due heartbeats.", r.resolved)
                    : _t("Deferred %s past-due heartbeats to their next slot.", r.resolved),
                { type: "info" },
            );
            load();
        } catch (e) {
            notification.add(e?.message || _t("Could not resolve the heartbeats"), { type: "danger" });
        } finally {
            setResolvingHb(false);
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
            enable_lore_tool: 1,
            expression_style: "",
            speech_tag_style: "",
            enable_web_search: 1,
            enable_x_search: 1,
            enable_grok_imagine_tools: 1,
            enable_capture_tools: 1,
            enable_memory_tools: 1,
            enable_delegate_tool: 1,
            enable_multi_agent_delegation: 0,
            enable_local_tasks: 0,
            enable_call_agents_tool: 1,
            when_to_call_description: "",
            enable_affection_tool: 0,
            affection_animations: 1,
            affection_animation_min_delta: 5,
            affection_score: 150,
            affection_rules: DEFAULT_AFFECTION_RULES,
            affection_max_score: 1000,
            affection_level_count: 10,
            affection_max_delta: 5,
            affection_max_delta_major: 200,
            enable_end_call_tool: 1,
            wake_phrase: "",
            wake_action: "resume_last",
            time_aware_resume: 0,
            speaks_first: 0,
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
        // Offer to take the linked avatar along — but only when no other
        // companion wears it (the server re-checks; it also keeps bundled
        // read-only packs and says so via avatar_note).
        const av = avatars.find((x) => x.id === a.avatar_id);
        const shared = !!av && agents.some((o) => o.id !== a.id && o.avatar_id === a.avatar_id);
        const checkboxLabel = av && !shared
            ? _t("Also delete its avatar '%s' (pack files included)", av.name)
            : null;
        const msg = _t("Delete %s? This permanently removes the companion plus all its sessions, transcripts and memories.", a.name);
        const answer = checkboxLabel
            ? await confirmAsk(msg, { checkboxLabel })
            : await confirmAsk(msg);
        const ok = checkboxLabel ? answer?.ok : answer;
        const deleteAvatar = checkboxLabel ? !!answer?.checked : false;
        if (!ok) return;
        // Deleting cascades through every session/message/memory row — a
        // companion with a long history takes seconds. Lock the list rows
        // until the server confirms so it can't be clicked mid-flight.
        setDeletingId(a.id);
        try {
            const resp = await rpc("/api/agents/delete", {
                id: a.id, delete_avatar: deleteAvatar ? 1 : 0,
            });
            if (deleteAvatar && !resp.avatar_deleted && resp.avatar_note) {
                notification.add(_t("Avatar kept: %s", resp.avatar_note), { type: "warning" });
            }
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
            lore: exportOpts.lore ? "1" : "0",
            heartbeats: exportOpts.heartbeats ? "1" : "0",
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
                    ["avatar", _t("Avatar"), _t("The avatar pack (models, outfits, backgrounds)")],
                    ["lore", _t("Lore"), _t("Lore stories tagged with this companion")],
                    ["memories", _t("Memories"), _t("What the companion remembers about you — personal; leave off when sharing")],
                    ["sessions", _t("Sessions"), _t("Your full conversation transcripts — personal; leave off when sharing")],
                    ["heartbeats", _t("Heartbeats"), _t("Scheduled prompts — imported inactive, ready to review and switch on")],
                ].map(([k, label, hint]) => (
                    <label key={k} className="small" title={hint}
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
                    title={_t("Export companion package (.zip) — settings and prompt, plus avatar, lore, memories and sessions on their own toggles; shareable with any rexclaw install")}
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

    // Open row-level drafts inside the editor (heartbeats, MCP connections,
    // lore stories). Panels register {dirty, flush}; the main Save commits
    // them first, and their dirtiness feeds the unsaved guard — so a draft
    // can never silently die because the user pressed the wrong Save button.
    const childEditors = useRef({});
    const [childDirty, setChildDirty] = useState(false);
    const registerChildEditor = useCallback((key, entry) => {
        if (entry) childEditors.current[key] = entry;
        else delete childEditors.current[key];
        const any = Object.values(childEditors.current).some((e) => e.dirty);
        setChildDirty((prev) => (prev === any ? prev : any));
    }, []);

    const saveAgent = async () => {
        if (!editingAgent) return false;
        setSaving(true);
        try {
            // Main Save means "save everything on this page": commit open
            // heartbeat/MCP/lore drafts first. An incomplete draft refuses
            // (with its own toast) and keeps the editor open.
            for (const entry of Object.values(childEditors.current)) {
                if (entry?.dirty && !(await entry.flush())) return false;
            }
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
    // Child drafts count as unsaved too: leaving the tab with an open
    // heartbeat/MCP/lore edit prompts Save / Discard like any form edit.
    const anyDirty = agentDirty || childDirty;
    useUnsavedGuard(active, anyDirty, saveAgent, () => setEditingAgent(null));
    // Leaving the tab closes the editor so coming back lands on the list. By
    // the time `active` drops the guard has already resolved any unsaved
    // edits (Save / Discard), so nothing is lost here.
    useEffect(() => { if (!active) setEditingAgent(null); }, [active]);

    const sort = useListSort("rexclaw.companions_sort");
    const q = query.trim().toLowerCase();
    const visibleAgents = sort.apply(
        q ? agents.filter((a) => (a.name || "").toLowerCase().includes(q)) : agents);
    // Hook lives above the editor early-return so it runs every render.
    const pager = usePager(visibleAgents.length);

    // Editing opens as its own view replacing the list — same navigation
    // pattern as the avatar editor. The editor renders Settings-style white
    // section boxes directly into the inner column.
    if (editingAgent) {
        return (
            <div className="rx_settings">
                <div className="rx_settings_inner rx_settings_inner--wide">
                    <AgentEditorFields editingAgent={editingAgent} setEditingAgent={setEditingAgent}
                                       avatars={avatars} saving={saving} saveAgent={saveAgent}
                                       dirty={anyDirty}
                                       registerChildEditor={registerChildEditor}
                                       cancel={() => setEditingAgent(null)} />
                </div>
            </div>
        );
    }

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3><i className="fa fa-users" /> {_t("Companions")}</h3>
                    <div style={{ display: "flex", alignItems: "stretch", gap: "0.5rem", marginBottom: "0.5rem", flexWrap: "wrap" }}>
                        <input
                            type="text"
                            placeholder={_t("Search companions…")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            style={{ flex: "1 1 14rem", minWidth: "10rem" }}
                        />
                        <select value={sort.sortBy} title={_t("List order")}
                                style={{ flex: "0 0 auto", width: "auto" }}
                                onChange={(e) => sort.setSortBy(e.target.value)}>
                            <option value="name">{_t("Sort: name")}</option>
                            <option value="created">{_t("Sort: created")}</option>
                        </select>
                        <button className="btn btn-sm" onClick={restorePresets} style={{ whiteSpace: "nowrap" }}
                                title={_t("Re-create any deleted preset companions (Eve, Ara, Rex, Sal, Leo) with their original prompts. Existing companions are untouched.")}>
                            <i className="fa fa-undo" /> {_t("Restore presets")}
                        </button>
                        <button className="btn btn-sm" disabled={importing} style={{ whiteSpace: "nowrap" }}
                                title={_t("Import a companion package (.zip) exported from another rexclaw install")}
                                onClick={() => importInputRef.current?.click()}>
                            <i className="fa fa-upload" /> {importing ? _t("Importing…") : _t("Import")}
                        </button>
                        <button className="btn btn-sm btn-primary" style={{ whiteSpace: "nowrap" }} onClick={newCompanion}>
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
                    </div>
                    {pastDueHb > 0 && (
                        <p className="small" style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.25rem 0" }}>
                            <i className={resolvingHb ? "fa fa-spinner fa-spin" : "fa fa-clock-o"} />
                            <span title={_t("Heartbeat schedules that came due while the app was closed. They never run on their own — decide here in one go, or per heartbeat inside each companion's editor.")}>
                                {resolvingHb
                                    ? _t("Working through the past-due heartbeats — each execution is a full model turn, this can take a while…")
                                    : _t("%s past-due heartbeats pending your decision.", pastDueHb)}
                            </span>
                            <button className="btn btn-sm" disabled={resolvingHb}
                                    onClick={() => resolveAllHeartbeats("execute")}>
                                <i className="fa fa-play" /> {_t("Execute all")}
                            </button>
                            <button className="btn btn-sm" disabled={resolvingHb}
                                    onClick={() => resolveAllHeartbeats("defer")}>
                                <i className="fa fa-forward" /> {_t("Defer all")}
                            </button>
                        </p>
                    )}
                    {!!query.trim() && !visibleAgents.length && (
                        <p className="text-muted small">{_t("No matches.")}</p>
                    )}
                    <Pager pager={pager} />
                    {pager.slice(visibleAgents).map((a) => (
                        <div key={a.id} className="rx_memory_row rx_memory_row--portrait"
                             style={deletingId != null && deletingId !== a.id ? { opacity: 0.6 } : undefined}>
                            <Portrait url={avatars.find((x) => x.id === a.avatar_id)?.portrait_url} size="sm" />
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
function AgentEditorFields({ editingAgent, setEditingAgent, avatars, saving, saveAgent, dirty,
                             registerChildEditor, cancel }) {
    const idScope = editingAgent.id ?? "new";
    // Stable per-panel registration callbacks (see lib/child_editor.js).
    const regHeartbeats = useCallback((e) => registerChildEditor("heartbeats", e), [registerChildEditor]);
    const regMcp = useCallback((e) => registerChildEditor("mcp", e), [registerChildEditor]);
    const regLore = useCallback((e) => registerChildEditor("lore", e), [registerChildEditor]);
    const [promptPreview, setPromptPreview] = useState(null);
    /** Bundled companions only: load the shipped prompt/voice/avatar/tool
     *  settings into the draft. Nothing is saved here — the unsaved bar
     *  appears and Save applies it (Discard backs out). */
    const resetToStock = async () => {
        try {
            const r = await rpc("/api/agents/stock_values", { id: editingAgent.id });
            setEditingAgent({ ...editingAgent, ...r.values });
        } catch (e) {
            notification.add(e?.message || _t("Could not load the stock settings"), { type: "danger" });
        }
    };
    const loadPromptPreview = async (ev) => {
        if (!ev.target.open) return;
        setPromptPreview(null);
        try {
            const r = await rpc("/api/agents/preview_prompt", { id: editingAgent.id });
            setPromptPreview(r.prompt);
        } catch (e) {
            notification.add(e?.message || _t("Could not compute the prompt preview"), { type: "danger" });
        }
    };
    return (
        <>
            <section>
            <h3 className="rx_editor_head">
                <span>
                    <i className="fa fa-users" />{" "}
                    {editingAgent.id == null ? _t("New companion") : _t("Edit companion")}
                    {editingAgent.name ? ` — ${editingAgent.name}` : ""}
                </span>
                {editingAgent.id != null && editingAgent.is_stock && (
                    <button className="btn btn-sm" onClick={resetToStock}
                            title={_t("Put this bundled companion's prompt, voice, avatar, wake phrase and tool settings back to how they shipped. Loads into the form — Save to apply, Discard to back out. Conversations, memories, lore and affection progress are kept.")}>
                        <i className="fa fa-undo" /> {_t("Reset to stock")}
                    </button>
                )}
            </h3>
            <div className="rx_row">
                <div>
                    <label>{_t("Name")}</label>
                    <input type="text" value={editingAgent.name || ""}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, name: ev.target.value })} />
                </div>
                <div className="rx_avatar_pick">
                    <label>{_t("Avatar")}</label>
                    <Portrait url={avatars.find((x) => x.id === editingAgent.avatar_id)?.portrait_url} size="sm" />
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
            {editingAgent.id != null && (
                <details onToggle={loadPromptPreview} style={{ margin: "0.5rem 0" }}>
                    <summary style={{ cursor: "pointer" }}>{_t("Computed voice prompt (read-only)")}</summary>
                    <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                        {_t("Exactly what a solo voice session receives: the environment preamble, the saved system prompt, and the dynamic tool/expression/memory sections. Computed from the last saved state; unsaved edits above are not included.")}
                    </p>
                    <textarea rows={18} readOnly value={promptPreview ?? _t("Computing…")} />
                </details>
            )}
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
            <label>{_t("Chat preferences")}</label>
            <div className="rx_flags">
                <span className="rx_check">
                    <input id={`flag-${idScope}-time_aware_resume`} type="checkbox"
                           checked={!!editingAgent.time_aware_resume}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, time_aware_resume: ev.target.checked ? 1 : 0 })} />
                    <label htmlFor={`flag-${idScope}-time_aware_resume`}
                           title={_t("When you resume a conversation, a dated note tells the companion when the two of you last spoke and how long ago that was, so it can pick up naturally after hours or days instead of mid-sentence. The note is visible in the transcript, which is why this is off by default.")}>
                        {_t("Time-aware resume (note how long it has been)")}
                    </label>
                </span>
                <span className="rx_check">
                    <input id={`flag-${idScope}-speaks_first`} type="checkbox"
                           checked={!!editingAgent.speaks_first}
                           onChange={(ev) => setEditingAgent({ ...editingAgent, speaks_first: ev.target.checked ? 1 : 0 })} />
                    <label htmlFor={`flag-${idScope}-speaks_first`}
                           title={_t("On voice calls the companion opens the conversation as soon as the call connects, instead of waiting for you to speak. Off by default - every call then starts with a turn from them.")}>
                        {_t("Speaks first on voice calls")}
                    </label>
                </span>
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
            {!!editingAgent.enable_gesture_emotion_tools && (
                <>
                    <label title={_t("Appended to the built-in avatar-expression instructions every voice session gets, under a 'Your signature gestures' heading. Name the gestures that are characteristically THIS companion's and the moments that call for them. The general mechanics are already covered - leave empty and the generic guidance stands alone.")}>
                        {_t("Signature gestures (optional)")}
                    </label>
                    <p className="text-muted small" style={{ margin: "0 0 0.25rem" }}>
                        {_t("Gestures for reference: %s, plus any custom gestures on the avatar.", BUILTIN_GESTURES)}
                    </p>
                    <textarea rows={4} value={editingAgent.expression_style || ""}
                              placeholder={_t("e.g. 'spin for a playful twirl on a real success; shoot as a terse copy-that.'")}
                              onChange={(ev) => setEditingAgent({ ...editingAgent, expression_style: ev.target.value })} />
                </>
            )}
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
                        <label title={_t("Built-in xAI voice names such as ara work as-is. For a custom voice, create or clone one in the xAI console (console.x.ai) and paste its voice id here.")}>{_t("Voice (built-in name or custom xAI voice id)")}</label>
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
                {(editingAgent.provider || "grok") === "grok" && (
                    <>
                        <label title={_t("Appended to the built-in speech-tag instructions every Grok voice session gets, under a 'Your signature tags' heading. Name the tags that are characteristically THIS companion's and the moments that call for them; two or three example lines in their voice work well. The general mechanics are already covered - leave empty and the generic guidance stands alone.")}>
                            {_t("Signature speech tags (optional)")}
                        </label>
                        <p className="text-muted small" style={{ margin: "0 0 0.25rem" }}>
                            {_t("Grok voice renders expression tags in speech. Inline: %s. Wrapping: %s. All of them are always available.", GROK_INLINE_TAGS, GROK_WRAPPING_TAGS)}
                        </p>
                        <textarea rows={4} value={editingAgent.speech_tag_style || ""}
                                  placeholder={_t("e.g. 'Favour [pause] and <slow> for weight; [chuckle] for dry humor.'")}
                                  onChange={(ev) => setEditingAgent({ ...editingAgent, speech_tag_style: ev.target.value })} />
                    </>
                )}
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
                        {editingAgent.affection_animations !== 0 && (
                            <label
                                   title={_t("Only score changes of at least this size play the effect — small routine nudges stay invisible, so the hearts keep meaning something. Default 5 (the normal per-call maximum).")}>
                                {_t("from ±")}
                                <input type="number" min={1} max={1000000} style={{ width: "4.5rem", marginLeft: "0.35rem" }}
                                       value={editingAgent.affection_animation_min_delta ?? 5}
                                       onChange={(ev) => {
                                           const v = parseInt(ev.target.value, 10);
                                           setEditingAgent({ ...editingAgent, affection_animation_min_delta: Number.isFinite(v) ? Math.max(1, v) : 5 });
                                       }} />
                            </label>
                        )}
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
                    <McpConnections agentId={editingAgent.id} registerEditor={regMcp} />
                ) : (
                    <>
                        <h3><i className="fa fa-server" /> {_t("Remote MCP connections")}</h3>
                        <p className="text-muted small" style={{ margin: 0 }}>
                            {_t("Remote MCP connections can be added after the companion is saved.")}
                        </p>
                    </>
                )}
            </section>
            <section>
                {editingAgent.id != null ? (
                    <HeartbeatsPanel agentId={editingAgent.id} agentName={editingAgent.name || ""}
                                     registerEditor={regHeartbeats} />
                ) : (
                    <>
                        <h3><i className="fa fa-heartbeat" /> {_t("Heartbeats")}</h3>
                        <p className="text-muted small" style={{ margin: 0 }}>
                            {_t("Heartbeats can be added after the companion is saved.")}
                        </p>
                    </>
                )}
            </section>
            <section>
                {editingAgent.id != null && editingAgent.name ? (
                    <LoreStoriesPanel agentName={editingAgent.name} registerEditor={regLore} />
                ) : (
                    <>
                        <h3><i className="fa fa-book" /> {_t("Lore stories")}</h3>
                        <p className="text-muted small" style={{ margin: 0 }}>
                            {_t("Lore stories can be added after the companion is saved.")}
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
function McpConnections({ agentId, registerEditor = null }) {
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
            const { _snap, ...fields } = editing;
            await rpc("/api/mcp/save", { ...fields, agent_id: agentId });
            setEditing(null);
            load();
            return true;
        } catch (e) {
            notification.add(e?.message || "Save failed", { type: "danger" });
            return false;
        } finally {
            setBusy(false);
        }
    };

    // The companion form's Save commits an open connection draft too.
    useRegisterChildEditor(registerEditor, editorDirty(editing), async () => {
        if (!editing || !editorDirty(editing)) return true;
        if (!editing.server_label.trim() || !editing.server_url.trim()) {
            notification.add(
                _t("The open MCP connection draft is incomplete — finish it or cancel it, then save again."),
                { type: "warning" });
            return false;
        }
        return save();
    });

    const remove = async (c) => {
        if (!(await confirmAsk(_t("Remove MCP connection %s?", c.server_label)))) return;
        try {
            await rpc("/api/mcp/delete", { id: c.id });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const set = (key, value) => setEditing((c) => ({ ...c, [key]: value }));

    // Rendered at the top for a NEW connection, in place of the edited row
    // otherwise — a form jumping to the top of the list is disorienting.
    const editorForm = editing && (
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
    );

    return (
        <div>
            {/* div, not <label>: a label forwards clicks anywhere on it to
                its first button, so clicking the heading text (or the empty
                row space) would trigger Add connection. */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3 style={{ margin: 0 }}><i className="fa fa-server" /> {_t("Remote MCP connections")}</h3>
                <button className="btn btn-sm" onClick={() => setEditing(withEditorSnapshot({ ...EMPTY_MCP }))}>
                    <i className="fa fa-plus" /> {_t("Add connection")}
                </button>
            </div>
            {editing && editing.id == null && editorForm}
            {!conns.length && !editing && (
                <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                    {_t("None configured. An MCP server gives this companion extra tools; xAI connects to it directly, so the URL must be public HTTPS.")}
                </p>
            )}
            {conns.map((c) => (editing && editing.id === c.id) ? (
                <React.Fragment key={c.id}>{editorForm}</React.Fragment>
            ) : (
                <div key={c.id} className="rx_memory_row">
                    <strong>{c.server_label}</strong>
                    <span className="rx_memory_content text-muted small">{c.server_url}</span>
                    <span className="rx_memory_meta">
                        {c.active ? "" : "inactive · "}
                        {c.enable_for_voice ? "voice " : ""}{c.enable_for_text ? "text" : ""}
                        {c.has_authorization ? " · 🔑" : ""}
                    </span>
                    <button className="btn btn-sm btn-link p-0"
                            onClick={() => setEditing(withEditorSnapshot({ ...c, authorization: "" }))}>
                        {_t("Edit")}
                    </button>
                    <button className="btn btn-sm btn-link p-0" title={_t("Remove")} onClick={() => remove(c)}>
                        <i className="fa fa-trash-o" />
                    </button>
                </div>
            ))}
        </div>
    );
}
