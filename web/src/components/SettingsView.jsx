import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t, i18nState, setLocale, LOCALES } from "../lib/i18n";
import { applyHotkeys } from "../lib/hotkeys";
import { wakeWord, wakeState } from "../lib/wake_word";
import { useReactive } from "../lib/reactive";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { services } from "../services/index";
import { UnsavedBar } from "./UnsavedUI.jsx";
import HotkeysSettings from "./HotkeysSettings.jsx";
import ModelsDialog from "./ModelsDialog.jsx";
import CreditsDialog from "./CreditsDialog.jsx";

// Languages the server can fetch a Vosk wake-word model for (keep in sync
// with WAKE_MODELS in server/routes/misc.py).
const WAKE_LANGUAGES = [
    ["en", "English"], ["ja", "日本語"], ["de", "Deutsch"], ["fr", "Français"],
    ["es", "Español"], ["zh", "中文"], ["ru", "Русский"], ["pt", "Português"],
];

// Local generation (ComfyUI). One engine switch per Imagine tool, and one
// exported workflow per capability — keep the slot ids in sync with SLOTS
// in server/local_gen.py.
const LOCAL_GEN_TOOLS = [
    ["imagine_image_backend", "create_image", "Images"],
    ["imagine_video_backend", "create_video", "Videos"],
    ["imagine_background_backend", "change_background", "Backgrounds (voice calls)"],
];
const LOCAL_GEN_SLOTS = [
    ["image", "Text to image", "create_image from a prompt alone, and still backgrounds."],
    ["image_edit", "Image edit (references)", "create_image featuring you, other companions, your photo or library images. Needs LoadImage node(s)."],
    ["video", "Text to video", "create_video from a prompt alone, and animated backgrounds."],
    ["video_i2v", "Image to video", "create_video from a source image or featuring you: the frame the clip starts from."],
];

/** One-line detection summary of an inspected workflow. */
function workflowSummary(s) {
    return [
        s.prompt ? `${_t("prompt")}: ${s.prompt}${s.prompt_has_marker ? " {prompt}" : ""}` : _t("no prompt node"),
        `${s.image_inputs} LoadImage`,
        s.length_inputs ? `${s.fps} fps` : null,
        s.outputs?.length ? `→ ${s.outputs.join("/")}` : null,
    ].filter(Boolean).join(" · ");
}

/** Settings: global app configuration — BYOK key + models, user identity and
 *  context-management thresholds. Companions and avatar packs have their own
 *  tabs (CompanionsView / AvatarsView); stored memories live on Memories. */
export default function SettingsView({ active }) {
    const wk = useReactive(wakeState);
    const [config, setConfig] = useState(null);
    const [apiKeyDraft, setApiKeyDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [headset, setHeadset] = useState(null);   // desktop shell only: HTTPS-on-WiFi state
    const [startInMascot, setStartInMascot] = useState(null);  // desktop shell only
    const [launchAtLogin, setLaunchAtLogin] = useState(null);  // desktop shell only: {supported, enabled}
    const [modelsOpen, setModelsOpen] = useState(false);   // "See all models" dialog
    const [creditsOpen, setCreditsOpen] = useState(false);
    // Hotkey overrides, parsed out of config.hotkeys_json for editing and
    // serialised back on save.
    const [hotkeys, setHotkeys] = useState({});
    // Unsaved-changes tracking for the leave guard. The ref mirrors `dirty`
    // so the load effect can read it without re-subscribing.
    const [dirty, setDirty] = useState(false);
    const dirtyRef = useRef(false);
    const markDirty = (v) => { dirtyRef.current = v; setDirty(v); };
    // User photo: uploads immediately (its own endpoint, not part of the
    // draft/Save flow) — no separate on/off toggle, its presence is what
    // gates create_image/create_video's include_user.
    const [photoUploading, setPhotoUploading] = useState(false);
    const photoInputRef = useRef(null);
    // Local generation: workflow JSON files load through one hidden file
    // input into the draft config (saved with the rest); the server's
    // detection summary per slot shows what a companion would drive.
    const [wfSummaries, setWfSummaries] = useState({});
    const [wfSlot, setWfSlot] = useState(null);         // slot the file picker was opened for
    const wfInputRef = useRef(null);
    const [comfyTest, setComfyTest] = useState(null);   // null | "busy" | {ok, ...} | {error}
    // Write-only like the API key: the server only reports whether one is
    // stored; a typed value is sent on Save, null clears it.
    const [authDraft, setAuthDraft] = useState("");
    // The YouTube Data API key (Live chat) works the same way.
    const [ytKeyDraft, setYtKeyDraft] = useState("");
    // So does the Text-To-VRMA access token (Gesture generation).
    const [vrmaTokenDraft, setVrmaTokenDraft] = useState("");
    const [typesafeKeyDraft, setTypesafeKeyDraft] = useState("");
    const [jevTest, setJevTest] = useState(null);
    const [vrmaTest, setVrmaTest] = useState(null);     // null | "busy" | {ok, ...} | {error}
    const onUserPhotoSelected = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = "";
        if (!file) return;
        setPhotoUploading(true);
        try {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const res = await rpc("/api/config/user_photo", { image_data_url: dataUrl });
            setConfig((c) => ({ ...c, user_photo_url: res.user_photo_url }));
        } catch (e) {
            notification.add(e?.message || _t("Upload failed"), { type: "danger" });
        } finally {
            setPhotoUploading(false);
        }
    };
    const clearUserPhoto = async () => {
        try {
            await rpc("/api/config/user_photo/clear", {});
            setConfig((c) => ({ ...c, user_photo_url: null }));
        } catch (e) {
            notification.add(e?.message || _t("Could not remove photo"), { type: "danger" });
        }
    };

    const load = async () => {
        try {
            const cfg = await rpc("/api/config/get", {});
            setConfig(cfg);
            let parsed = {};
            try {
                const raw = cfg.hotkeys_json ? JSON.parse(cfg.hotkeys_json) : null;
                if (raw && typeof raw === "object") parsed = raw;
            } catch (e) { /* corrupt blob — fall back to the defaults */ }
            setHotkeys(parsed);
            inspectWorkflows(cfg);
            markDirty(false);   // freshly loaded = pristine
        } catch (e) {
            notification.add(e?.message || _t("Could not load settings"), { type: "danger" });
        }
    };

    useEffect(() => {
        // Never re-fetch over unsaved edits (belt-and-braces — the leave
        // guard already blocks navigating away while dirty).
        if (active && !dirtyRef.current) load();
        // Desktop shell only: current headset-access + startup-mode state from
        // the Electron bridge (null in plain browsers → sections stay hidden).
        if (active) {
            window.rexclawDesktop?.headsetInfo?.().then(setHeadset).catch(() => {});
            window.rexclawDesktop?.startupMascot?.().then((v) => setStartInMascot(!!v)).catch(() => {});
            window.rexclawDesktop?.launchAtLogin?.().then(setLaunchAtLogin).catch(() => {});
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

    /** OS login item — written straight to the OS by the shell, so it
     *  applies immediately, independent of Save settings. */
    const toggleLaunchAtLogin = async (flag) => {
        const previous = launchAtLogin;
        setLaunchAtLogin((v) => ({ ...v, enabled: flag }));
        try {
            const res = await window.rexclawDesktop.setLaunchAtLogin(flag);
            setLaunchAtLogin(res);
            if (res?.error) notification.add(res.error, { type: "danger" });
        } catch (e) {
            setLaunchAtLogin(previous);
            notification.add(e?.message || _t("Could not save that."), { type: "danger" });
        }
    };

    /** Put the app's shipped model ids back into every model field (the
     *  config table's column defaults, so an update that bumps a default is
     *  one click away for existing installs). Marks the form dirty — Save
     *  still applies it. */
    const restoreSuggestedModels = async () => {
        try {
            const res = await rpc("/api/xai/model_defaults");
            setConfig((c) => ({ ...c, ...res.defaults }));
            markDirty(true);
        } catch (e) {
            notification.add(e?.message || _t("Could not load the suggested models."), { type: "danger" });
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

    const setField = (key, value) => { markDirty(true); setConfig((c) => ({ ...c, [key]: value })); };
    const changeHotkeys = (next) => { markDirty(true); setHotkeys(next); };

    /** Detection summaries for every stored workflow (advisory — a failure
     *  just leaves the slot showing "loaded"). */
    const inspectWorkflows = async (cfg) => {
        const workflows = {};
        for (const [slot] of LOCAL_GEN_SLOTS) {
            if (cfg[`local_gen_${slot}_workflow`]) workflows[slot] = cfg[`local_gen_${slot}_workflow`];
        }
        if (!Object.keys(workflows).length) { setWfSummaries({}); return; }
        try {
            const res = await rpc("/api/local_gen/inspect", { workflows });
            setWfSummaries(res.slots || {});
        } catch (e) { /* summaries are advisory */ }
    };
    const pickWorkflow = (slot) => { setWfSlot(slot); wfInputRef.current?.click(); };
    const onWorkflowSelected = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = "";
        const slot = wfSlot;
        if (!file || !slot) return;
        try {
            const text = await file.text();
            const res = await rpc("/api/local_gen/inspect", { workflows: { [slot]: text } });
            const summary = res.slots?.[slot];
            if (!summary || summary.ok === false) {
                notification.add(summary?.error || _t("That file is not a ComfyUI API-format workflow."), { type: "danger" });
                return;
            }
            setWfSummaries((s) => ({ ...s, [slot]: summary }));
            setField(`local_gen_${slot}_workflow`, text);
        } catch (e) {
            notification.add(e?.message || _t("Could not read that workflow."), { type: "danger" });
        }
    };
    const clearWorkflow = (slot) => {
        setWfSummaries((s) => { const next = { ...s }; delete next[slot]; return next; });
        setField(`local_gen_${slot}_workflow`, "");
    };
    const testComfy = async () => {
        setComfyTest("busy");
        try {
            setComfyTest(await rpc("/api/local_gen/test", {
                url: config.local_gen_url, auth_header: authDraft || "",
            }));
        } catch (e) {
            setComfyTest({ error: e?.message || _t("Connection failed") });
        }
    };
    const testJev = async () => {
        setJevTest("busy");
        try {
            setJevTest(await rpc("/api/face_director/test", { key: typesafeKeyDraft || "", model: config.jev_model || "" }));
        } catch (e) {
            setJevTest({ error: e?.message || _t("Connection failed") });
        }
    };
    const testVrma = async () => {
        setVrmaTest("busy");
        try {
            setVrmaTest(await rpc("/api/gesture_gen/test", {
                url: config.gesture_gen_url, token: vrmaTokenDraft || "",
            }));
        } catch (e) {
            setVrmaTest({ error: e?.message || _t("Connection failed") });
        }
    };

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
            delete payload.has_local_gen_auth;
            if (authDraft.trim()) payload.local_gen_auth_header = authDraft.trim();
            else if (authDraft === null) payload.local_gen_auth_header = null;
            delete payload.has_youtube_api_key;
            if (ytKeyDraft?.trim()) payload.live_chat_youtube_api_key = ytKeyDraft.trim();
            else if (ytKeyDraft === null) payload.live_chat_youtube_api_key = null;
            delete payload.has_gesture_gen_token;
            if (vrmaTokenDraft?.trim()) payload.gesture_gen_token = vrmaTokenDraft.trim();
            else if (vrmaTokenDraft === null) payload.gesture_gen_token = null;
            delete payload.has_typesafe_api_key;
            if (typesafeKeyDraft?.trim()) payload.typesafe_api_key = typesafeKeyDraft.trim();
            else if (typesafeKeyDraft === null) payload.typesafe_api_key = null;
            await rpc("/api/config/set", payload);
            setApiKeyDraft("");
            setAuthDraft("");
            setYtKeyDraft("");
            setVrmaTokenDraft("");
            setTypesafeKeyDraft("");
            // Re-bind immediately — including the OS-wide registration, which
            // only the shell can change.
            applyHotkeys({
                bindings: hotkeys,
                globalEnabled: !!config.hotkeys_global_enabled,
            });
            // Standby listening reconciles against the saved config (arms,
            // disarms, or starts the model download as needed).
            wakeWord.refresh();
            // Motion settings take effect at once, mid-call included — the
            // director otherwise only reads them when it next restarts.
            services.motion_director?.applySettings?.({
                speech_gestures: !!config.speech_gestures,
                idle_fidgets: !!config.idle_fidgets,
                fidget_interval: config.fidget_interval,
                gesture_zoom_out: !!config.gesture_zoom_out,
            });
            markDirty(false);
            load();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
            return false;
        } finally {
            setSaving(false);
        }
    };

    // Discarding the draft = re-fetch the saved config.
    const discard = () => load();

    // Publish unsaved state to the app-level leave guard while this is the
    // active tab. Must run before the early return so hook order stays stable.
    useUnsavedGuard(active, dirty, saveConfig, discard);

    if (!config) {
        return <div className="rx_settings"><div className="rx_settings_inner">{_t("Loading…")}</div></div>;
    }

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-user" /> {_t("You")}</h3>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Display name (optional)")}</label>
                            <input type="text" value={config.user_display_name || ""}
                                   onChange={(ev) => setField("user_display_name", ev.target.value)} />
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
                            {_t("Include my name in the system prompt")}
                        </label>
                    </div>
                    <div className="rx_user_photo" style={{ marginTop: "0.75rem" }}>
                        <label>{_t("Your photo (optional)")}</label>
                        <p className="text-muted small" style={{ margin: "0 0 0.4rem" }}>
                            {_t("If set, any companion with Grok Imagine enabled can feature you in a generated image or video, using this photo as reference. Only upload one you're comfortable being used that way.")}
                        </p>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            {config.user_photo_url && (
                                <img src={config.user_photo_url} alt={_t("Your photo")}
                                     style={{ width: "3.5rem", height: "3.5rem", objectFit: "cover", borderRadius: "0.4rem" }} />
                            )}
                            <button type="button" className="btn btn-sm" disabled={photoUploading}
                                    onClick={() => photoInputRef.current?.click()}>
                                <i className={photoUploading ? "fa fa-spinner fa-spin" : "fa fa-upload"} />{" "}
                                {config.user_photo_url ? _t("Replace") : _t("Upload")}
                            </button>
                            {config.user_photo_url && (
                                <button type="button" className="btn btn-sm btn-link" onClick={clearUserPhoto}>
                                    {_t("Remove")}
                                </button>
                            )}
                            <input ref={photoInputRef} type="file" accept="image/png,image/jpeg,image/webp"
                                   style={{ display: "none" }} onChange={onUserPhotoSelected} />
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-bolt" /> {_t("TypeSafe (Jev)")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Jev is a judgment model: it answers a pile of small questions about "
                            + "one line at once, in a fraction of a second. Features that have to "
                            + "read something while it is still happening use it, and share this "
                            + "one key. Costs a fraction of a penny an hour of conversation. Reads "
                            + "English best.")}
                    </p>
                    <div className="rx_row">
                        <div style={{ flex: 2 }}>
                            <label>
                                {_t("TypeSafe API key")}
                                {config.has_typesafe_api_key && typesafeKeyDraft !== null && (
                                    <span className="text-muted"> ({_t("saved")}{" "}
                                        <a href="#" onClick={(ev) => { ev.preventDefault(); markDirty(true); setTypesafeKeyDraft(null); }}>{_t("remove")}</a>)
                                    </span>
                                )}
                            </label>
                            <input type="password" value={typesafeKeyDraft || ""}
                                   placeholder={config.has_typesafe_api_key && typesafeKeyDraft !== null
                                       ? _t("•••••••• (leave blank to keep current key)")
                                       : ""}
                                   onChange={(ev) => { markDirty(true); setTypesafeKeyDraft(ev.target.value); }} />
                        </div>
                        <div>
                            <label title={_t("jev-latest is TypeSafe's alias for their newest Jev release. Enter a version such as jev-1.13.0 to stay on it when a new one comes out. Test shows the version the name resolves to.")}>
                                {_t("Jev model")}
                            </label>
                            <input type="text" value={config.jev_model || ""}
                                   placeholder="jev-latest"
                                   onChange={(ev) => setField("jev_model", ev.target.value)} />
                        </div>
                        <div style={{ alignSelf: "flex-end" }}>
                            <button className="btn btn-light" onClick={testJev} disabled={jevTest === "busy"}>
                                <i className={jevTest === "busy" ? "fa fa-spinner fa-spin" : "fa fa-plug"} /> {_t("Test")}
                            </button>
                        </div>
                    </div>
                    {jevTest && jevTest !== "busy" && (
                        <p className={"small " + (jevTest.ok ? "text-muted" : "text-danger")}>
                            {jevTest.ok
                                ? `${jevTest.model} · ${_t("first call")} ${jevTest.cold_ms} ms · ${_t("then")} ${jevTest.warm_ms} ms`
                                : jevTest.error}
                        </p>
                    )}
                    <p className="text-muted small">
                        {_t("Used by: Expressive face and head, Automated background gestures, "
                            + "and picking who speaks next in a group call. The last two fall "
                            + "back to the turn director model without a key.")}
                    </p>
                </section>

                <section>
                    <h3><i className="fa fa-child" /> {_t("Background Avatar Motion")}</h3>
                    <p className="text-muted">
                        {_t("Extra body language on top of the avatar's own gesture set, "
                            + "picked up in the background.")}
                    </p>
                    <div className="rx_check">
                        <input id="rx_speech_gestures" type="checkbox"
                               checked={!!config.speech_gestures}
                               onChange={(ev) => setField("speech_gestures", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_speech_gestures">
                            {_t("Automated background gestures while speaking (experimental)")}
                        </label>
                    </div>
                    <p className="text-muted">
                        {_t("Your companion gestures along with what they're saying: a bow "
                            + "for thanks, a shrug for \"oh well\". Needs a motion clip "
                            + "library to pick from.")}
                    </p>
                    {!!config.speech_gestures && (
                    <p className="text-muted small">
                        {config.has_typesafe_api_key
                            ? _t("Jev reads each sentence against the clip library and answers in "
                                + "about a quarter of a second, so the gesture is ready well before "
                                + "the line is spoken. Sent for each line: the sentence itself and "
                                + "your companion's \"## Identity\" and \"## Personality\" sections.")
                            : _t("The turn director model set below reads each sentence against the "
                                + "clip library. Set a TypeSafe API key above and Jev does it "
                                + "instead — faster, cheaper and a better match.")}
                    </p>
                    )}
                    <div className="rx_check">
                        <input id="rx_face_director" type="checkbox"
                               checked={!!config.face_director}
                               onChange={(ev) => setField("face_director", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_face_director">
                            {_t("Expressive face and head while speaking (experimental - requires Jev)")}
                        </label>
                    </div>
                    <p className="text-muted">
                        {_t("Your companion's face and head follow what each sentence means, and "
                            + "what you say to them: a smile, a frown, a nod on a yes, a shake on "
                            + "a no, a look away while they think. Built from the avatar's own "
                            + "expressions, so any VRM works. Their own big emotions still play on "
                            + "top. Needs a TypeSafe API key for Jev, set above. Applies from the "
                            + "next call.")}
                    </p>
                    {!!config.face_director && (
                    <p className="text-muted small">
                        {_t("Sent to TypeSafe for each line: the sentence itself, the last two "
                            + "messages of the conversation, and your companion's \"## Identity\" "
                            + "and \"## Personality\" sections, each up to the next heading. "
                            + "Nothing else goes: not their memories, their lore, the rest of "
                            + "their prompt, or your voice. Those two sections are what set how "
                            + "much a feeling shows and how an ambiguous line reads in character, "
                            + "so keep your companion's prompt in the standard section format. A "
                            + "prompt without those headings falls back to its first 1200 "
                            + "characters, whatever they happen to be.")}
                    </p>
                    )}
                    <div className="rx_check">
                        <input id="rx_idle_fidgets" type="checkbox"
                               checked={!!config.idle_fidgets}
                               onChange={(ev) => setField("idle_fidgets", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_idle_fidgets">{_t("Idle fidgets")}</label>
                    </div>
                    <p className="text-muted">
                        {_t("Small movements while your companion stands there quietly: a "
                            + "shift of weight, folded arms, a touch of their hair.")}
                    </p>
                    {!!config.idle_fidgets && (
                        <div className="rx_row">
                            <div>
                                <label title={_t("An average, not a metronome. The real gap varies either side of it so the movements never fall into a rhythm.")}>
                                    {_t("Fidget every (seconds, average)")}
                                </label>
                                <input type="number" min="3" step="1"
                                       value={config.fidget_interval ?? 60}
                                       onChange={(ev) => setField("fidget_interval",
                                           Number(ev.target.value) || 60)} />
                            </div>
                        </div>
                    )}
                    <div className="rx_check">
                        <input id="rx_gesture_zoom_out" type="checkbox"
                               checked={!!config.gesture_zoom_out}
                               onChange={(ev) => setField("gesture_zoom_out", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_gesture_zoom_out">{_t("Zoom out for manual gestures in face view")}</label>
                    </div>
                    <p className="text-muted">
                        {_t("The camera pulls out while a gesture plays, so it is not out of "
                            + "shot, then eases back in. Only for gestures someone chose (the "
                            + "companion's own, or the trigger buttons), not the automated ones "
                            + "above.")}
                    </p>
                </section>

                {startInMascot !== null && (
                    <section>
                        <h3><i className="fa fa-desktop" /> {_t("Desktop app")}</h3>
                        {launchAtLogin?.supported && (
                            <>
                                <div className="rx_check">
                                    <input id="rx_launch_at_login" type="checkbox"
                                           checked={!!launchAtLogin.enabled}
                                           onChange={(ev) => toggleLaunchAtLogin(ev.target.checked)} />
                                    <label htmlFor="rx_launch_at_login">
                                        {_t("Launch Rexclaw when you sign in to your computer")}
                                    </label>
                                </div>
                                <p className="text-muted">
                                    {_t("Starts Rexclaw by itself each time you sign in. Pair it "
                                        + "with mascot mode below to have your companion waiting "
                                        + "on the desktop.")}
                                </p>
                            </>
                        )}
                        <div className="rx_check">
                            <input id="rx_start_mascot" type="checkbox"
                                   checked={!!startInMascot}
                                   onChange={(ev) => toggleStartInMascot(ev.target.checked)} />
                            <label htmlFor="rx_start_mascot">
                                {_t("Open in mascot mode")}
                            </label>
                        </div>
                        <p className="text-muted">
                            {_t("Mascot mode opens Rexclaw as the pop-out avatar on your "
                                + "desktop instead of the app window. Pop back in from the "
                                + "avatar's controls or the tray icon. Applies from the next "
                                + "launch.")}
                        </p>
                        <div className="rx_check">
                            <input id="rx_hb_notifications" type="checkbox"
                                   checked={!!config.heartbeat_notifications}
                                   onChange={(ev) => setField("heartbeat_notifications", ev.target.checked ? 1 : 0)} />
                            <label htmlFor="rx_hb_notifications">
                                {_t("Desktop notifications for heartbeats")}
                            </label>
                        </div>
                        <p className="text-muted">
                            {_t("Heartbeats that write to you can raise a system notification "
                                + "when they run, even while Rexclaw sits in the tray or behind "
                                + "other windows. Clicking it opens the chat with that companion. "
                                + "Only heartbeats with 'Notify me when it runs' ticked take part, "
                                + "so a diary stays quiet. Requires notifications to be on in "
                                + "Windows Settings › System › Notifications (and off Do Not Disturb).")}
                        </p>
                        <button className="btn btn-secondary" style={{ marginBottom: "0.5rem" }}
                                title={_t("Raises a sample notification right now, so you can check that Windows shows them for this app.")}
                                onClick={() => window.rexclawDesktop.notify?.({
                                    title: "Rexclaw",
                                    body: _t("Notifications are working. A companion's message will look like this."),
                                }).then((ok) => {
                                    if (!ok) notification.add(_t("This system reports no notification support."), { type: "warning" });
                                }).catch(() => {})}>
                            <i className="fa fa-bell-o" /> {_t("Send a test notification")}
                        </button>
                        {/* Own line, well clear of the test-notification button
                            above, so neither gets clicked by mistake. */}
                        <button className="btn btn-secondary" style={{ display: "block", marginTop: "1.25rem" }}
                                onClick={() => window.rexclawDesktop.openMascotSettings?.()}>
                            <i className="fa fa-cog" /> {_t("Open mascot settings")}
                        </button>
                    </section>
                )}

                <section>
                    <h3><i className="fa fa-key" /> {_t("xAI connection")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Manage keys, usage and custom voices in the")}{" "}
                        <a href="https://console.x.ai" target="_blank" rel="noreferrer">{_t("xAI console")}</a>.{" "}
                        {_t("Model rates:")}{" "}
                        <a href="https://docs.x.ai/docs/models" target="_blank" rel="noreferrer">{_t("xAI pricing")}</a>.
                    </p>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("How voice calls are billed (approximate, check xAI pricing for "
                            + "current rates): a voice call is charged per minute for as long "
                            + "as it stays connected, whether or not anyone is speaking. That "
                            + "is about $0.08 a minute ($4.80 an hour) on "
                            + "grok-voice-think-fast-2.0, for each companion in the call. "
                            + "On top of that there is a flat fee of about $0.004 per message "
                            + "exchanged, whatever its length. Tools like web search and Grok "
                            + "Imagine (images and videos) are charged separately. Resuming a "
                            + "voice conversation sends its history back one message at a "
                            + "time (incurring the $0.004 charge per message), so if you "
                            + "resume often, review the \"Cost optimization\" section in "
                            + "Settings. Text chat is "
                            + "billed differently, by the number of tokens, at the rates of "
                            + "the model used.")}
                    </p>
                    <label>{_t("API key")} {config.has_api_key && <span className="text-muted">({_t("saved")} {config.api_key_hint || ""})</span>}</label>
                    <input
                        type="password"
                        placeholder={config.has_api_key ? _t("•••••••• (leave blank to keep current key)") : "xai-…"}
                        value={apiKeyDraft}
                        onChange={(ev) => { markDirty(true); setApiKeyDraft(ev.target.value); }}
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
                        <div>
                            <label title={_t("Quicker, shallower text model that delegate_task can pick with model='fast' for looking at images, screenshots and clips or reading short documents. Empty = same as the Text model.")}>
                                {_t("Fast text model (delegate tool)")}
                            </label>
                            <input type="text" value={config.delegate_fast_model || ""}
                                   placeholder="grok-4.20-non-reasoning"
                                   onChange={(ev) => setField("delegate_fast_model", ev.target.value)} />
                        </div>
                    </div>
                    <div className="rx_model_actions">
                        <button className="btn btn-light" onClick={restoreSuggestedModels}
                                title={_t("Fill every model field with the ids this version of Rexclaw ships with and is tested against. Save to apply.")}>
                            <i className="fa fa-undo" /> {_t("Restore suggested models")}
                        </button>
                        <button className="btn btn-light" onClick={() => setModelsOpen(true)}
                                title={_t("List every model your xAI key can reach, by kind. For reference — not every model suits every field.")}>
                            <i className="fa fa-list-ul" /> {_t("See all models")}
                        </button>
                    </div>
                    {modelsOpen && <ModelsDialog apiKey={apiKeyDraft} onClose={() => setModelsOpen(false)} />}
                </section>

                <section>
                    <h3><i className="fa fa-keyboard-o" /> {_t("Hotkeys")}</h3>
                    <HotkeysSettings
                        value={hotkeys}
                        globalEnabled={config.hotkeys_global_enabled}
                        onChange={changeHotkeys}
                        onGlobalChange={(v) => setField("hotkeys_global_enabled", v)} />
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
                        <div>
                            <label title={_t("Most-recent messages loaded into the transcript when a "
                                             + "conversation is resumed; 0 shows everything. Older messages "
                                             + "stay stored — this only affects what is painted on screen, "
                                             + "not what the companion remembers.")}>
                                {_t("Transcript messages shown on resume")}
                            </label>
                            <input type="number" min="0" value={config.transcript_display_limit ?? 200}
                                   onChange={(ev) => setField("transcript_display_limit", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-tags" /> {_t("Cost optimization")}</h3>
                    <p className="text-muted">
                        {_t("Resuming a voice conversation sends its history back to xAI one "
                            + "message at a time, at about $0.004 per message, so a "
                            + "250-message backlog costs about $1 on every resume. With the "
                            + "roll-up on, the older messages are bundled into a single "
                            + "message, which cuts that to a few cents. Every word is still "
                            + "sent, but the bundled part arrives as one transcript, so your "
                            + "companion may recall it a little less sharply than the recent "
                            + "turns kept whole. Most useful if you resume often for short "
                            + "exchanges. Note: every summarization trims the message backlog, "
                            + "so a resume costs the most just before one is due.")}
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
                        <p className="text-muted">
                            {_t("xAI drops an idle call at 15 minutes regardless. 0 turns "
                                + "this off.")}
                        </p>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-assistive-listening-systems" /> {_t("Voice activation")}</h3>
                    <p className="text-muted">
                        {_t("Say a companion's wake phrase, such as \"hey Eve\", to start a "
                            + "call hands-free. Set the phrase per companion on the "
                            + "Companions tab. Listening runs entirely on this machine. The "
                            + "microphone stays on while it listens, so your system will "
                            + "show its mic indicator.")}
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
                    <h3><i className="fa fa-comments" /> {_t("Live chat")}</h3>
                    <p className="text-muted">
                        {_t("Let companions read your stream's chat through idle events: set a companion's idle event to 'Read stream chat' on the Companions tab. Chat only connects during a call whose companion has such an event, and disconnects a minute after the call ends.")}
                    </p>
                    <div className="rx_row">
                        <div>
                            <label title={_t("Read anonymously - no Twitch account or token needed. Messages a moderator deletes, and everything from a user they time out or ban, are dropped before a companion reads them.")}>
                                {_t("Twitch channel")}
                            </label>
                            <input type="text" value={config.live_chat_twitch_channel || ""}
                                   placeholder={_t("channel name or twitch.tv link")}
                                   onChange={(ev) => setField("live_chat_twitch_channel", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("The link (or video id) of the stream that's live right now - each new stream has a new link. Chat is checked every 20 seconds to stay inside YouTube's free daily API quota.")}>
                                {_t("YouTube live stream")}
                            </label>
                            <input type="text" value={config.live_chat_youtube_video || ""}
                                   placeholder="https://www.youtube.com/watch?v=…"
                                   onChange={(ev) => setField("live_chat_youtube_video", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("A YouTube Data API v3 key from the Google Cloud console (APIs & Services → Credentials). Stored on this machine only.")}>
                                {_t("YouTube API key")}
                                {config.has_youtube_api_key && ytKeyDraft !== null && (
                                    <span className="text-muted"> ({_t("saved")}{" "}
                                        <a href="#" onClick={(ev) => { ev.preventDefault(); markDirty(true); setYtKeyDraft(null); }}>{_t("remove")}</a>)
                                    </span>
                                )}
                            </label>
                            <input type="password" value={ytKeyDraft || ""}
                                   placeholder={config.has_youtube_api_key && ytKeyDraft !== null
                                       ? _t("•••••••• (leave blank to keep current key)")
                                       : "AIza…"}
                                   onChange={(ev) => { markDirty(true); setYtKeyDraft(ev.target.value); }} />
                        </div>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label title={_t("Messages from these names never reach a companion - chat bots, or anyone you'd rather not hear from. Comma-separated, not case-sensitive.")}>
                                {_t("Ignored users (comma-separated)")}
                            </label>
                            <input type="text" value={config.live_chat_ignored_users || ""}
                                   onChange={(ev) => setField("live_chat_ignored_users", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("A message containing any of these is dropped before a companion reads it - matched anywhere, inside words too. Comma-separated, not case-sensitive. Commands starting with ! are always skipped.")}>
                                {_t("Blocked words (comma-separated)")}
                            </label>
                            <input type="text" value={config.live_chat_blocked_words || ""}
                                   onChange={(ev) => setField("live_chat_blocked_words", ev.target.value)} />
                        </div>
                    </div>
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
                {headset && !headset.external && (
                    <section>
                        <h3><i className="fa fa-wifi" /> {_t("VR headset & other devices (HTTPS)")}</h3>
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
                        <p className="text-muted">
                            {_t("Turn this on to use Rexclaw on other devices on your WiFi: "
                                + "in VR from a headset's browser (Quest, Pico), or on a phone "
                                + "or tablet (iPhone, iPad, Android), where you can also add it "
                                + "to the home screen. Open the URL shown here on the device "
                                + "and accept its one-time certificate warning. If Windows "
                                + "Firewall asks, allow access. Switching it on restarts the "
                                + "app's server in HTTPS mode and reloads this window.")}
                        </p>
                    </section>
                )}

                <section>
                    <h3><i className="fa fa-desktop" /> {_t("Local generation (ComfyUI)")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Render the companions' image and video tools on your own ComfyUI server instead of Grok Imagine: any model ComfyUI runs, no per-generation billing. A companion's \"Image & video tools\" toggle still decides whether the tools are offered at all; this only picks the engine behind each tool.")}
                    </p>
                    <div className="rx_row">
                        <div style={{ flex: 2 }}>
                            <label>{_t("ComfyUI URL")}</label>
                            <input type="text" value={config.local_gen_url || ""} placeholder="http://127.0.0.1:8188"
                                   onChange={(ev) => setField("local_gen_url", ev.target.value)} />
                        </div>
                        <div style={{ flex: 2 }}>
                            <label title={_t("Sent on every request. For a rented pod behind a proxy password or a hosted service's API key. Leave empty for a plain local ComfyUI.")}>
                                {_t("Auth header (optional)")}
                                {config.has_local_gen_auth && authDraft !== null && (
                                    <span className="text-muted"> ({_t("saved")}{" "}
                                        <a href="#" onClick={(ev) => { ev.preventDefault(); markDirty(true); setAuthDraft(null); }}>{_t("remove")}</a>)
                                    </span>
                                )}
                            </label>
                            <input type="password" value={authDraft || ""}
                                   placeholder={config.has_local_gen_auth && authDraft !== null
                                       ? _t("•••••••• (leave blank to keep current header)")
                                       : "Authorization: Bearer …"}
                                   onChange={(ev) => { markDirty(true); setAuthDraft(ev.target.value); }} />
                        </div>
                        <div style={{ alignSelf: "flex-end" }}>
                            <button className="btn btn-light" onClick={testComfy} disabled={comfyTest === "busy"}>
                                <i className={comfyTest === "busy" ? "fa fa-spinner fa-spin" : "fa fa-plug"} /> {_t("Test connection")}
                            </button>
                        </div>
                    </div>
                    {comfyTest && comfyTest !== "busy" && (
                        <p className={"small " + (comfyTest.ok ? "text-muted" : "text-danger")} style={{ margin: "0.25rem 0 0.5rem" }}>
                            {comfyTest.ok
                                ? `ComfyUI ${comfyTest.version || ""} · ${(comfyTest.devices || [])
                                    .map((d) => `${d.name} (${d.vram_free_gb} / ${d.vram_total_gb} GB VRAM ${_t("free")})`)
                                    .join(", ") || _t("no GPU reported")}`
                                : comfyTest.error}
                        </p>
                    )}
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Rexclaw in Docker or WSL while ComfyUI runs on Windows? Start ComfyUI with --listen and use that machine's address (from Docker: http://host.docker.internal:8188).")}
                    </p>
                    <div className="rx_row">
                        {LOCAL_GEN_TOOLS.map(([key, tool, label]) => (
                            <div key={key}>
                                <label>{_t(label)} <span className="text-muted">({tool})</span></label>
                                <select value={config[key] || "xai"} onChange={(ev) => setField(key, ev.target.value)}>
                                    <option value="xai">{_t("Grok Imagine (xAI)")}</option>
                                    <option value="local">{_t("Local (ComfyUI)")}</option>
                                </select>
                            </div>
                        ))}
                    </div>
                    <label style={{ marginTop: "0.5rem" }}>{_t("Workflows")}</label>
                    <p className="text-muted small" style={{ margin: "0 0 0.4rem" }}>
                        {_t("In ComfyUI, load a template for the model you want (Qwen Image Edit for image edits, Wan 2.2 image-to-video for clips, …), run it once so its models download, then Workflow → Export (API) and load that file here. Nothing needs renaming: the prompt, LoadImage, seed, size and length inputs are detected. Put {prompt} inside the positive prompt text to keep the rest as a fixed style prefix.")}
                    </p>
                    {LOCAL_GEN_SLOTS.map(([slot, label, hint]) => {
                        const text = config[`local_gen_${slot}_workflow`];
                        const s = wfSummaries[slot];
                        return (
                            <div key={slot} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", marginBottom: "0.4rem" }}>
                                <div style={{ flex: 1 }}>
                                    <strong>{_t(label)}</strong>{" "}
                                    <span className="text-muted small">{_t(hint)}</span>
                                    <div className="small">
                                        {!text && <span className="text-muted">{_t("not set")}</span>}
                                        {text && !s && _t("loaded")}
                                        {text && s && (s.ok === false
                                            ? <span className="text-danger">{s.error}</span>
                                            : workflowSummary(s))}
                                        {s?.warnings?.map((w, i) => <div key={i} className="text-danger">{w}</div>)}
                                    </div>
                                </div>
                                <button type="button" className="btn btn-sm" onClick={() => pickWorkflow(slot)}>
                                    <i className="fa fa-upload" /> {text ? _t("Replace") : _t("Load JSON")}
                                </button>
                                {text && (
                                    <button type="button" className="btn btn-sm btn-link" onClick={() => clearWorkflow(slot)}>
                                        {_t("Remove")}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                    <input ref={wfInputRef} type="file" accept="application/json,.json"
                           style={{ display: "none" }} onChange={onWorkflowSelected} />
                </section>

                <section>
                    <h3><i className="fa fa-magic" /> {_t("Gesture generation (Text-To-VRMA)")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Lets companions invent brand-new avatar motions from a description during voice calls (generate_gesture), made by the free, open-source Text-To-VRMA app running on your computer.")}{" "}
                        <a href="https://github.com/Kirakun0328/text-to-vrma/releases" target="_blank" rel="noreferrer">{_t("Download Text-To-VRMA")}</a>.{" "}
                        {_t("In that app open Advanced settings → Local HTTP API and switch it on, then copy the address and the access token it shows into the fields below. Its local ARDY engine is free and needs no key (press \"Start engine\" in the app first); the OpenAI, Claude and Codex engines use the keys or login saved in that app.")}
                    </p>
                    <div className="rx_check">
                        <input id="rx_gesture_gen_enabled" type="checkbox"
                               checked={!!config.gesture_gen_enabled}
                               onChange={(ev) => setField("gesture_gen_enabled", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_gesture_gen_enabled">
                            {_t("Enable gesture generation")}
                        </label>
                    </div>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("The master switch. Each companion also needs \"Gesture generation\" switched on in the Companions tab, and the tool is only offered while the app is answering.")}
                    </p>
                    <div className="rx_row">
                        <div style={{ flex: 2 }}>
                            <label>{_t("Text-To-VRMA API URL")}</label>
                            <input type="text" value={config.gesture_gen_url || ""} placeholder="http://127.0.0.1:8787"
                                   onChange={(ev) => setField("gesture_gen_url", ev.target.value)} />
                        </div>
                        <div style={{ flex: 2 }}>
                            <label title={_t("The access token Text-To-VRMA shows once its Local HTTP API is enabled. Fixed per install; if you regenerate it in the app, paste the new one here.")}>
                                {_t("Access token")}
                                {config.has_gesture_gen_token && vrmaTokenDraft !== null && (
                                    <span className="text-muted"> ({_t("saved")}{" "}
                                        <a href="#" onClick={(ev) => { ev.preventDefault(); markDirty(true); setVrmaTokenDraft(null); }}>{_t("remove")}</a>)
                                    </span>
                                )}
                            </label>
                            <input type="password" value={vrmaTokenDraft || ""}
                                   placeholder={config.has_gesture_gen_token && vrmaTokenDraft !== null
                                       ? _t("•••••••• (leave blank to keep current token)")
                                       : ""}
                                   onChange={(ev) => { markDirty(true); setVrmaTokenDraft(ev.target.value); }} />
                        </div>
                        <div style={{ alignSelf: "flex-end" }}>
                            <button className="btn btn-light" onClick={testVrma} disabled={vrmaTest === "busy"}>
                                <i className={vrmaTest === "busy" ? "fa fa-spinner fa-spin" : "fa fa-plug"} /> {_t("Test connection")}
                            </button>
                        </div>
                    </div>
                    {vrmaTest && vrmaTest !== "busy" && (
                        <p className={"small " + (vrmaTest.ok ? "text-muted" : "text-danger")} style={{ margin: "0.25rem 0 0.5rem" }}>
                            {vrmaTest.ok
                                ? `Text-To-VRMA · ${_t("engines")}: ${(vrmaTest.engines || []).join(", ")} · `
                                    + `OpenAI ${_t("key")}: ${vrmaTest.openai_key ? _t("set") : _t("not set")} · `
                                    + `Claude ${_t("key")}: ${vrmaTest.claude_key ? _t("set") : _t("not set")}`
                                : vrmaTest.error}
                        </p>
                    )}
                    <div className="rx_row">
                        <div>
                            <label title={_t("What makes the motion, same choice as in the app. ARDY is NVIDIA's motion model running locally: free, a few seconds per motion on a GPU, best at full-body movement. The others have a language model write the keyframes: slower, billed by that provider (Codex uses your ChatGPT subscription).")}>
                                {_t("Engine")}
                            </label>
                            <select value={config.gesture_gen_engine || "ardy"}
                                    onChange={(ev) => setField("gesture_gen_engine", ev.target.value)}>
                                <option value="ardy">{_t("ARDY local engine (free)")}</option>
                                <option value="openai">OpenAI API</option>
                                <option value="claude">Claude API</option>
                                <option value="codex">{_t("Codex (ChatGPT subscription)")}</option>
                            </select>
                        </div>
                        {(config.gesture_gen_engine || "ardy") === "ardy" ? (
                            <div>
                                <label title={_t("Optionally let a language model read the description first and split it into steps for ARDY (\"run, then jump\"). None sends the description straight to ARDY: fastest, no key needed.")}>
                                    {_t("ARDY planner")}
                                </label>
                                <select value={config.gesture_gen_planner || "none"}
                                        onChange={(ev) => setField("gesture_gen_planner", ev.target.value)}>
                                    <option value="none">{_t("None (fastest)")}</option>
                                    <option value="codex">Codex</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="claude">Claude</option>
                                </select>
                            </div>
                        ) : (config.gesture_gen_engine === "openai" || config.gesture_gen_engine === "codex") ? (
                            <div>
                                <label title={_t("Fast keeps the model's thinking and keyframe count down and skips the second review pass, the right choice mid-conversation. Quality thinks longer.")}>
                                    {_t("Speed")}
                                </label>
                                <select value={config.gesture_gen_speed || "fast"}
                                        onChange={(ev) => setField("gesture_gen_speed", ev.target.value)}>
                                    <option value="fast">{_t("Fast")}</option>
                                    <option value="balanced">{_t("Balanced")}</option>
                                    <option value="quality">{_t("Quality")}</option>
                                </select>
                            </div>
                        ) : <div />}
                        <div>
                            <label title={_t("Model id for the chosen engine or planner, as you would pick it in the app. Empty = the app's default.")}>
                                {_t("Model (optional)")}
                            </label>
                            <input type="text" value={config.gesture_gen_model || ""}
                                   onChange={(ev) => setField("gesture_gen_model", ev.target.value)} />
                        </div>
                    </div>
                    <p className="text-muted small" style={{ margin: "0.5rem 0 0" }}>
                        {_t("Rexclaw in Docker or WSL while Text-To-VRMA runs on Windows? The app only listens on 127.0.0.1, so it has to be on the same machine as the Rexclaw server (the desktop app and run.bat are). Generated motions land in data/assets/generated/text_to_vrma/ and show up in every avatar's Library picker.")}
                    </p>
                </section>

                <div className="rx_settings_footer">
                    <button className="btn btn-link" onClick={() => setCreditsOpen(true)}>
                        <i className="fa fa-heart-o" /> {_t("Credits")}
                    </button>
                </div>
                {creditsOpen && <CreditsDialog onClose={() => setCreditsOpen(false)} />}

                <UnsavedBar dirty={dirty} saving={saving}
                            onSave={saveConfig} onDiscard={discard} />
            </div>
        </div>
    );
}
