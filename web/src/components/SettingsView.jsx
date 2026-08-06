import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t, i18nState, setLocale, LOCALES } from "../lib/i18n";
import { applyHotkeys } from "../lib/hotkeys";
import { wakeWord, wakeState } from "../lib/wake_word";
import { useReactive } from "../lib/reactive";
import HotkeysSettings from "./HotkeysSettings.jsx";

// Languages the server can fetch a Vosk wake-word model for (keep in sync
// with WAKE_MODELS in server/routes/misc.py).
const WAKE_LANGUAGES = [
    ["en", "English"], ["ja", "日本語"], ["de", "Deutsch"], ["fr", "Français"],
    ["es", "Español"], ["zh", "中文"], ["ru", "Русский"], ["pt", "Português"],
];

/** Settings: global app configuration — BYOK key + models, user identity and
 *  context-management thresholds. Companions and avatar packs have their own
 *  tabs (CompanionsView / AvatarsView); stored memories live on Memories. */
export default function SettingsView({ active }) {
    const wk = useReactive(wakeState);
    const [config, setConfig] = useState(null);
    const [apiKeyDraft, setApiKeyDraft] = useState("");
    const [agents, setAgents] = useState([]);
    const [saving, setSaving] = useState(false);
    const [headset, setHeadset] = useState(null);   // desktop shell only: HTTPS-on-WiFi state
    const [startInMascot, setStartInMascot] = useState(null);  // desktop shell only
    const [hideMascotIdle, setHideMascotIdle] = useState(false);  // desktop shell only
    // Hotkey overrides, parsed out of config.hotkeys_json for editing and
    // serialised back on save.
    const [hotkeys, setHotkeys] = useState({});

    const load = async () => {
        try {
            const [cfg, ags] = await Promise.all([
                rpc("/api/config/get", {}),
                rpc("/api/agents/list", {}),
            ]);
            setConfig(cfg);
            setAgents(ags);
            let parsed = {};
            try {
                const raw = cfg.hotkeys_json ? JSON.parse(cfg.hotkeys_json) : null;
                if (raw && typeof raw === "object") parsed = raw;
            } catch (e) { /* corrupt blob — fall back to the defaults */ }
            setHotkeys(parsed);
        } catch (e) {
            notification.add(e?.message || _t("Could not load settings"), { type: "danger" });
        }
    };

    useEffect(() => {
        if (active) load();
        // Desktop shell only: current headset-access + startup-mode state from
        // the Electron bridge (null in plain browsers → sections stay hidden).
        if (active) {
            window.rexclawDesktop?.headsetInfo?.().then(setHeadset).catch(() => {});
            window.rexclawDesktop?.startupMascot?.().then((v) => setStartInMascot(!!v)).catch(() => {});
            window.rexclawDesktop?.mascotHideIdle?.().then((v) => setHideMascotIdle(!!v)).catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    /** Startup mode lives in the shell's own settings file (it has to be
     *  readable before any window exists), so it applies immediately rather
     *  than on Save — same as the headset toggle. */
    const toggleStartInMascot = async (flag) => {
        setStartInMascot(flag);
        try {
            await window.rexclawDesktop.setStartupMascot(flag);
        } catch (e) {
            setStartInMascot(!flag);
            notification.add(e?.message || _t("Could not save that."), { type: "danger" });
        }
    };

    /** Same shell-settings home (and immediate effect) as the startup mode —
     *  the shell pushes the change to a live mascot window. */
    const toggleHideMascotIdle = async (flag) => {
        setHideMascotIdle(flag);
        try {
            await window.rexclawDesktop.setMascotHideIdle(flag);
        } catch (e) {
            setHideMascotIdle(!flag);
            notification.add(e?.message || _t("Could not save that."), { type: "danger" });
        }
    };

    /** Flip HTTPS-on-WiFi. On success the shell restarts its server and
     *  reloads the window, so this component remounts on the new scheme. */
    const toggleHeadset = async () => {
        setHeadset((h) => (h ? { ...h, busy: true } : h));
        const res = await window.rexclawDesktop.headsetToggle();
        setHeadset(res);
        if (res?.error) notification.add(res.error, { type: "warning" });
    };

    if (!config) {
        return <div className="rx_settings"><div className="rx_settings_inner">{_t("Loading…")}</div></div>;
    }

    const setField = (key, value) => setConfig((c) => ({ ...c, [key]: value }));

    const saveConfig = async () => {
        setSaving(true);
        try {
            const payload = { ...config };
            delete payload.has_api_key;
            delete payload.api_key_hint;
            delete payload.spend_today_usd;
            delete payload.spend_lifetime_usd;
            payload.hotkeys_json = JSON.stringify(hotkeys);
            if (apiKeyDraft.trim()) payload.xai_api_key = apiKeyDraft.trim();
            await rpc("/api/config/set", payload);
            setApiKeyDraft("");
            // Re-bind immediately — including the OS-wide registration, which
            // only the shell can change.
            applyHotkeys({
                bindings: hotkeys,
                globalEnabled: !!config.hotkeys_global_enabled,
            });
            // Standby listening reconciles against the saved config (arms,
            // disarms, or starts the model download as needed).
            wakeWord.refresh();
            notification.add(_t("Settings saved."), { type: "info" });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-key" /> {_t("xAI connection")}</h3>
                    <label>{_t("API key")} {config.has_api_key && <span className="text-muted">({_t("saved")} {config.api_key_hint || ""})</span>}</label>
                    <input
                        type="password"
                        placeholder={config.has_api_key ? _t("•••••••• (leave blank to keep current key)") : "xai-…"}
                        value={apiKeyDraft}
                        onChange={(ev) => setApiKeyDraft(ev.target.value)}
                    />
                    <div className="rx_row">
                        <div>
                            <label>{_t("Voice model")}</label>
                            <input type="text" value={config.xai_model || ""}
                                   onChange={(ev) => setField("xai_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Text model")}</label>
                            <input type="text" value={config.text_model || ""}
                                   onChange={(ev) => setField("text_model", ev.target.value)} />
                        </div>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Summary model")}</label>
                            <input type="text" value={config.summary_model || ""}
                                   onChange={(ev) => setField("summary_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Imagine model")}</label>
                            <input type="text" value={config.imagine_model || ""}
                                   onChange={(ev) => setField("imagine_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("Grok Imagine video model used for animated backgrounds and the create_video tool.")}>
                                {_t("Imagine video model")}
                            </label>
                            <input type="text" value={config.imagine_video_model || ""}
                                   placeholder="grok-imagine-video-1.5"
                                   onChange={(ev) => setField("imagine_video_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("Model for the group-call turn director (a one-token \"who speaks next\" classification on every group-call turn). Latency matters more than intelligence here — use the fastest non-reasoning model available. Empty = fall back to the Text Model.")}>
                                {_t("Turn director model")}
                            </label>
                            <input type="text" value={config.director_model || ""}
                                   placeholder="grok-4.20-non-reasoning"
                                   onChange={(ev) => setField("director_model", ev.target.value)} />
                        </div>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label title={_t("xAI multi-agent model used when delegate_task is called with multi_agent=true. Several agents collaborate on the query and a leader synthesizes — every sub-agent bills tokens, so this is markedly more expensive than a standard call. Beta on xAI's side; custom function tools are NOT supported there.")}>
                                {_t("Multi-agent model")}
                            </label>
                            <input type="text" value={config.multi_agent_model || ""}
                                   placeholder="grok-4.20-multi-agent"
                                   onChange={(ev) => setField("multi_agent_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("reasoning.effort sent on multi-agent delegations — xAI maps low/medium to 4 collaborating agents, high/xhigh to 16.")}>
                                {_t("Multi-agent effort")}
                            </label>
                            <select value={config.multi_agent_effort || "low"}
                                    onChange={(ev) => setField("multi_agent_effort", ev.target.value)}>
                                <option value="low">{_t("Low (4 agents)")}</option>
                                <option value="medium">{_t("Medium (4 agents)")}</option>
                                <option value="high">{_t("High (16 agents)")}</option>
                                <option value="xhigh">{_t("X-High (16 agents)")}</option>
                            </select>
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-user" /> {_t("You")}</h3>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Display name (optional)")}</label>
                            <input type="text" value={config.user_display_name || ""}
                                   onChange={(ev) => setField("user_display_name", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Default companion")}</label>
                            <select value={config.default_agent_id ?? ""}
                                    onChange={(ev) => setField("default_agent_id", parseInt(ev.target.value, 10) || null)}>
                                {agents.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label>{_t("Language")}</label>
                            <select value={i18nState.locale}
                                    onChange={(ev) => setLocale(ev.target.value)}
                                    title={_t("UI language — stored in this browser. Companions follow the language you speak regardless.")}>
                                {LOCALES.map(([id, label]) => (
                                    <option key={id} value={id}>{label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="rx_check">
                        <input id="rx_include_name" type="checkbox"
                               checked={!!config.include_user_name_in_prompt}
                               onChange={(ev) => setField("include_user_name_in_prompt", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_include_name">
                            {_t("Include my name in the system prompt (sent to xAI — off by default)")}
                        </label>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-compress" /> {_t("Context management")}</h3>
                    <p className="text-muted">
                        {_t("A companion can only hold so much of a conversation in mind at "
                            + "once, so long ones are condensed as they go. Once a conversation "
                            + "has exceeded summarization threshold tokens since its last "
                            + "summary, the older part is boiled down into a short recap and "
                            + "carried forward in its place, while the most recent turns are "
                            + "kept word for word. Your companion keeps the gist of everything "
                            + "that came before, and the immediate thread stays sharp. Mid-call "
                            + "this happens during a natural pause, so it never interrupts you. "
                            + "Long-term memory and the full transcript stay accessible either "
                            + "way — condensed conversations are stored as episodes your "
                            + "companion can look up again with its recall tool.")}
                    </p>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Voice summarization threshold (tokens)")}</label>
                            <input type="number" value={config.summary_threshold_tokens ?? 0}
                                   onChange={(ev) => setField("summary_threshold_tokens", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                        <div>
                            <label>{_t("Text summarization threshold (tokens)")}</label>
                            <input type="number" value={config.summary_threshold_tokens_text ?? 0}
                                   onChange={(ev) => setField("summary_threshold_tokens_text", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                        <div>
                            <label title={_t("How many of the newest messages are left out of the recap "
                                             + "and carried forward word for word.")}>
                                {_t("Recent turns kept verbatim")}
                            </label>
                            <input type="number" min="0" value={config.summary_keep_recent_messages ?? 2}
                                   onChange={(ev) => setField("summary_keep_recent_messages", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-tags" /> {_t("Cost optimization")}</h3>
                    <p className="text-muted">
                        {_t("When you resume a conversation, its history is sent to xAI to "
                            + "restore the companion's memory of it — and xAI charges per "
                            + "message sent, about $0.004 each, no matter how short. A long "
                            + "relationship costs real money to pick up again: a 250-message "
                            + "conversation is about $1 every single time you resume it. That "
                            + "count is not your whole history, though — every summarization "
                            + "resets it, since the messages it condenses replay as a single "
                            + "recap. Only what has built up since the last summary is sent "
                            + "message by message — so the costliest moment to resume is just "
                            + "before a summary is due, when that backlog is at its largest.")}
                    </p>
                    <p className="text-muted">
                        {_t("Rolling up the history bundles the older messages into one single "
                            + "message instead of hundreds, taking that $1 down to under a cent. "
                            + "Nothing is deleted or summarised — every word is still sent, "
                            + "word for word. What changes is the shape: the bundled part "
                            + "arrives as one transcript rather than as separate turns, so your "
                            + "companion may recall it a little less sharply than the turns "
                            + "kept whole below. Recent turns are what matter most for staying "
                            + "in character, which is why they are left untouched.")}
                    </p>
                    <p className="text-muted">
                        {_t("Recommended if you dip in and out of a conversation for quick "
                            + "exchanges: short, frequent resumes are where replaying the "
                            + "history dominates the bill. On long calls it matters much less, "
                            + "because the per-minute charge for the call itself outweighs it.")}
                    </p>
                    <div className="rx_check">
                        <input id="rx_replay_rollup" type="checkbox"
                               checked={!!config.replay_rollup_enabled}
                               onChange={(ev) => setField("replay_rollup_enabled", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_replay_rollup">
                            {_t("Roll up older history when resuming a conversation")}
                        </label>
                    </div>
                    {!!config.replay_rollup_enabled && (
                        <div className="rx_row">
                            <div>
                                <label title={_t("How many of the most recent messages stay as separate turns, "
                                                 + "exactly as they are sent today. Everything older is bundled. "
                                                 + "Higher keeps more of the conversation's natural shape and "
                                                 + "costs a little more; 0 bundles everything.")}>
                                    {_t("Recent turns kept whole")}
                                </label>
                                <input type="number" min="0"
                                       value={config.replay_rollup_keep_recent ?? 20}
                                       onChange={(ev) => setField("replay_rollup_keep_recent", parseInt(ev.target.value, 10) || 0)} />
                            </div>
                        </div>
                    )}
                    <div className="rx_editor_section">
                        <p className="text-muted">
                            {_t("A call bills for as long as it stays connected, whether "
                                + "or not anyone is talking — so the expensive mistake is "
                                + "walking away from one. Rexclaw can hang up for you "
                                + "after a stretch with nothing happening: nobody spoke or "
                                + "typed, no companion took a turn, no tool ran. Muting "
                                + "does not count as leaving, and a companion mid-sentence "
                                + "is never cut off. The conversation is only ended, never "
                                + "lost — resuming picks it straight back up. xAI drops a "
                                + "call at 15 minutes regardless, so anything longer than "
                                + "that would never get the chance to fire. 0 turns it off.")}
                        </p>
                        <div className="rx_row">
                            <div>
                                <label>{_t("End the call after this many idle minutes")}</label>
                                <input type="number" min="0" max="15"
                                       value={config.call_inactivity_minutes ?? 5}
                                       onChange={(ev) => setField(
                                           "call_inactivity_minutes",
                                           Math.max(0, Math.min(15, parseInt(ev.target.value, 10) || 0)))} />
                            </div>
                            <div />
                            <div />
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-assistive-listening-systems" /> {_t("Voice activation")}</h3>
                    <p className="text-muted">
                        {_t("Start a call hands-free: with standby listening on, the "
                            + "microphone stays open while no call is live, and saying a "
                            + "companion's wake phrase (set per companion on the "
                            + "Companions tab — e.g. \"hey Eve\") starts one. Detection "
                            + "runs entirely on this machine with a small offline speech "
                            + "model — nothing is sent to xAI and nothing is billed "
                            + "until a call actually starts. The trade-off is an "
                            + "always-on microphone (your OS will show its mic "
                            + "indicator) and the one-time model download below. A soft "
                            + "chime confirms every wake.")}
                    </p>
                    <div className="rx_check">
                        <input id="rx_wake_enabled" type="checkbox"
                               checked={!!config.wake_word_enabled}
                               onChange={(ev) => setField("wake_word_enabled", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_wake_enabled">
                            {_t("Standby listening for wake phrases")}
                        </label>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label title={_t("Language of the offline model that spots the phrases — pick the language you'll SAY them in. Changing it downloads that language's model (~40-50 MB, one-time).")}>
                                {_t("Wake phrase language")}
                            </label>
                            <select value={config.wake_word_language || "en"}
                                    onChange={(ev) => setField("wake_word_language", ev.target.value)}>
                                {WAKE_LANGUAGES.map(([id, label]) => (
                                    <option key={id} value={id}>{label}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label>{_t("Status")}</label>
                            <div className="rx_wake_status">
                                {{
                                    "off": _t("Not listening"),
                                    "standby-other-window": _t("Listening in another window"),
                                    "acquiring": _t("Starting…"),
                                    "downloading-model": _t("Downloading speech model… %s%%",
                                        Math.round((wk.modelProgress || 0) * 100)),
                                    "loading-model": _t("Loading speech model…"),
                                    "listening": _t("Listening for wake phrases"),
                                    "error": wk.error || _t("Error"),
                                }[wk.status] || wk.status}
                            </div>
                        </div>
                    </div>
                    <p className="text-muted">
                        {_t("Applies when you save. Companions without a wake phrase "
                            + "are simply not listened for.")}
                    </p>
                </section>

                <section>
                    <h3><i className="fa fa-terminal" /> {_t("Local computer tasks")}</h3>
                    <p className="text-muted">
                        {_t("Companions with \"Local computer tasks\" enabled (per "
                            + "companion, on the Companions tab) can hand real work to "
                            + "the Grok Build CLI running on this machine: it creates "
                            + "and edits files, writes code and runs shell commands — "
                            + "for real, with no confirmation prompts — inside the "
                            + "working folder below. Leave the folder empty for a "
                            + "dedicated workspace inside Rexclaw's data folder; point "
                            + "it at a project only if you want companions working in "
                            + "it directly. Requires the Grok Build CLI ("
                            + "docs.x.ai/build) installed on this machine — without "
                            + "it the tool simply isn't offered. Billing: if you "
                            + "signed into the Grok CLI, tasks bill that login; "
                            + "otherwise your Rexclaw API key is used.")}
                    </p>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Working folder (empty = data/workspace)")}</label>
                            <input type="text"
                                   placeholder={_t("e.g. C:\\Users\\me\\rexclaw-workspace")}
                                   value={config.local_task_workdir || ""}
                                   onChange={(ev) => setField("local_task_workdir", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Grok Build CLI")}</label>
                            <div className="rx_wake_status">
                                {config.local_task_cli_path
                                    ? "✅ " + _t("Detected: %s", config.local_task_cli_path)
                                    : "❌ " + _t("Not found on this machine — install it, "
                                        + "then reopen Settings to re-check")}
                            </div>
                        </div>
                        <div />
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-keyboard-o" /> {_t("Hotkeys")}</h3>
                    <HotkeysSettings
                        value={hotkeys}
                        globalEnabled={config.hotkeys_global_enabled}
                        onChange={setHotkeys}
                        onGlobalChange={(v) => setField("hotkeys_global_enabled", v)} />
                </section>

                {startInMascot !== null && (
                    <section>
                        <h3><i className="fa fa-desktop" /> {_t("Desktop app")}</h3>
                        <p className="text-muted">
                            {_t("Mascot mode is the pop-out avatar: a small transparent "
                                + "always-on-top window with no app chrome around it. Start "
                                + "there and Rexclaw opens as the companion on your desktop "
                                + "rather than as an application window — the full window is "
                                + "still one \"pop back in\" away, from the avatar's controls "
                                + "or the tray icon. Takes effect on the next launch "
                                + "(independent of Save settings).")}
                        </p>
                        <div className="rx_check">
                            <input id="rx_start_mascot" type="checkbox"
                                   checked={!!startInMascot}
                                   onChange={(ev) => toggleStartInMascot(ev.target.checked)} />
                            <label htmlFor="rx_start_mascot">
                                {_t("Open in mascot mode")}
                            </label>
                        </div>
                        <div className="rx_check">
                            <input id="rx_hide_mascot_idle" type="checkbox"
                                   checked={!!hideMascotIdle}
                                   onChange={(ev) => toggleHideMascotIdle(ev.target.checked)} />
                            <label htmlFor="rx_hide_mascot_idle"
                                   title={_t("In mascot mode, the avatar disappears from the desktop while no call is live and pops back up (without stealing focus) when one starts. Pairs naturally with voice activation: the companion waits dormant and appears when you call their wake phrase. While hidden, the tray icon is the way back — click it or its \"Show Rexclaw\" entry.")}>
                                {_t("Hide the avatar between calls")}
                            </label>
                        </div>
                        <p className="text-muted">
                            {_t("Applies immediately. With \"hide between calls\" on, "
                                + "standby listening keeps running while the avatar is "
                                + "hidden — say the wake phrase and they appear.")}
                        </p>
                    </section>
                )}

                {headset && !headset.external && (
                    <section>
                        <h3><i className="fa fa-wifi" /> {_t("VR headset & other devices (HTTPS)")}</h3>
                        <p className="text-muted">
                            {_t("Opens this app to every device on your WiFi — VR headsets "
                                + "(Quest, Pico, …), phones and tablets — via the URL below. "
                                + "HTTPS is what makes the full experience work there: browsers "
                                + "only allow the microphone (voice calls) and WebXR on secure "
                                + "origins, so over plain HTTP another device could browse and "
                                + "text-chat but never talk. It also enables installing the app "
                                + "from the phone's browser (Add to Home Screen). Turning it on "
                                + "restarts the app's server in HTTPS mode and reloads this "
                                + "window; on each device, accept the one-time certificate "
                                + "warning, and on the PC allow access if Windows Firewall asks. "
                                + "Takes effect immediately (independent of Save settings).")}
                        </p>
                        <div className="rx_row">
                            <div>
                                <label>{_t("Serve over HTTPS on WiFi")}</label>
                                <div>
                                    <button className={"btn " + (headset.enabled ? "btn-primary" : "btn-light")}
                                            disabled={headset.busy}
                                            onClick={toggleHeadset}>
                                        <i className="fa fa-wifi" /> {headset.enabled ? _t("On") : _t("Off")}
                                    </button>
                                </div>
                            </div>
                            {headset.enabled && headset.url && (
                                <div>
                                    <label>{_t("Open this URL on the device (headset, phone, tablet)")}</label>
                                    <input type="text" readOnly value={headset.url}
                                           onFocus={(ev) => ev.target.select()} />
                                </div>
                            )}
                        </div>
                    </section>
                )}

                <section>
                    <button className="btn btn-primary" disabled={saving} onClick={saveConfig}>
                        <i className="fa fa-save" /> {_t("Save settings")}
                    </button>
                </section>
            </div>
        </div>
    );
}
