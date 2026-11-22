import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";

function parseSettings(text) {
    try {
        const v = JSON.parse(text || "{}");
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
}

/** The characters this companion makes up in a roleplay (create_character,
 *  server/look_tools.py): the voice setup and text chat brain they run on,
 *  and the voices the companion picks theirs from, each with a description
 *  — the description is all the companion goes by. Edits go into the
 *  editor's draft (agents.character_settings), so the editor's Save and
 *  Discard apply to them like any other field. */
export default function CharacterSettingsDialog({ editingAgent, setEditingAgent, voiceSetups, onClose }) {
    const settings = parseSettings(editingAgent.character_settings);
    const voices = Array.isArray(settings.voices) ? settings.voices : [];
    const [preset, setPreset] = useState([]);

    useEffect(() => {
        rpc("/api/agents/character_voice_preset", {}).then((r) => setPreset(r.voices || [])).catch(() => {});
    }, []);
    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const write = (patch) => {
        const next = { ...settings, ...patch };
        Object.keys(next).forEach((k) => {
            if (!next[k] || (Array.isArray(next[k]) && !next[k].length)) delete next[k];
        });
        setEditingAgent({ ...editingAgent, character_settings: Object.keys(next).length ? JSON.stringify(next) : "" });
    };
    const setVoice = (i, patch) => write({ voices: voices.map((v, j) => (j === i ? { ...v, ...patch } : v)) });

    // The setup the characters' calls run on: their own pick, else this
    // companion's, else the app default.
    const options = voiceSetups?.options || [];
    const byValue = (v) => options.find((o) => o.value === v);
    const ownSetup = byValue(editingAgent.voice_setup || voiceSetups?.default) || options[0];
    const setup = settings.voice_setup ? byValue(settings.voice_setup) || ownSetup : ownSetup;
    const onGrokVoice = !setup?.tts_connection;

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className="rx_dialog rx_dialog--characters" role="dialog" aria-modal="true"
                 onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Characters")}{editingAgent.name ? ` — ${editingAgent.name}` : ""}</h4>
                <p>
                    {_t("The characters this companion creates in a roleplay join the call as companions of their own. Choose what they run on and which voices the companion can give them.")}
                </p>
                <div className="rx_row">
                    <div>
                        <label>{_t("Voice setup")}</label>
                        <select value={settings.voice_setup || ""}
                                onChange={(ev) => write({ voice_setup: ev.target.value })}>
                            <option value="">{_t("Same as this companion (%s)", _t(ownSetup?.label || "Grok Realtime"))}</option>
                            {options.map((o) => <option key={o.value} value={o.value}>{_t(o.label)}</option>)}
                        </select>
                    </div>
                    <div>
                        <label>{_t("Text chat brain")}</label>
                        <select value={settings.text_brain || ""}
                                onChange={(ev) => write({ text_brain: ev.target.value })}>
                            <option value="">{_t("Same as this companion")}</option>
                            <option value="app">{_t("Grok (Settings → Text model)")}</option>
                            <option value="voice_setup" disabled={setup?.value === "realtime"}>
                                {setup?.value === "realtime"
                                    ? _t("The voice setup's brain (needs a voice setup)")
                                    : _t("The voice setup's brain: %s", setup?.brain || "")}
                            </option>
                        </select>
                    </div>
                </div>
                <label>
                    {onGrokVoice ? _t("Voices (Grok voice names or custom xAI voice ids)")
                        : _t("Voices (%s)", _t(setup?.voice_hint || "voice"))}
                </label>
                {!voices.length ? (
                    <p className="small">
                        {onGrokVoice
                            ? _t("Using Grok's %s voices with xAI's descriptions.", preset.length)
                            : _t("No list: characters get the voice setup's default voice.")}{" "}
                        <button className="btn btn-sm"
                                onClick={() => write({ voices: onGrokVoice && preset.length
                                    ? preset.map((v) => ({ ...v })) : [{ voice: "", description: "" }] })}>
                            <i className="fa fa-pencil" /> {onGrokVoice ? _t("Customise the list") : _t("Add voices")}
                        </button>
                    </p>
                ) : (
                    <div className="rx_character_voices">
                        {voices.map((v, i) => (
                            <div key={i} className="rx_subrow">
                                <input type="text" value={v.voice || ""} placeholder={_t("Voice")}
                                       style={{ flex: "0 0 8rem" }}
                                       onChange={(ev) => setVoice(i, { voice: ev.target.value })} />
                                <input type="text" value={v.description || ""}
                                       placeholder={_t("What it sounds like, e.g. deep older male, British accent")}
                                       onChange={(ev) => setVoice(i, { description: ev.target.value })} />
                                <button className="btn btn-sm btn-link p-0" title={_t("Remove")}
                                        onClick={() => write({ voices: voices.filter((_, j) => j !== i) })}>
                                    <i className="fa fa-trash-o" />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="rx_dialog_actions">
                    {voices.length > 0 && (
                        <>
                            <button className="btn btn-secondary"
                                    onClick={() => write({ voices: [...voices, { voice: "", description: "" }] })}>
                                <i className="fa fa-plus" /> {_t("Add voice")}
                            </button>
                            <button className="btn btn-secondary" onClick={() => write({ voices: [] })}
                                    title={onGrokVoice ? _t("Back to Grok's voices as shipped") : _t("Back to the setup's default voice")}>
                                {onGrokVoice ? _t("Use Grok's list") : _t("Clear the list")}
                            </button>
                        </>
                    )}
                    <button className="btn btn-primary" onClick={onClose}>{_t("Done")}</button>
                </div>
            </div>
        </div>
    );
}
