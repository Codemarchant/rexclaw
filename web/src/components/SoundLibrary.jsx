import React, { useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";
import { formatClock } from "../lib/format_clock";

/** History → Recordings → Your sounds: the user's uploaded beds, music and
 *  sound effects (server/audio_sounds.py). Each upload gets the fields the
 *  script grammar needs: the name scripts call it by, the kind (which
 *  directive plays it), a description companions read in their guide, a
 *  default level, and a credit line for the user's own licence records. */

const USE = { bed: "{bed %s}", music: "{music %s}", sound: "{sound %s}" };
const BLANK = { name: "", kind: "bed", description: "", level: 0, credit: "" };

/** "Velvet Pad (loop).wav" → "velvet-pad-loop" */
function slug(filename) {
    return (filename || "").replace(/\.[^.]+$/, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function SoundFields({ value, kinds, onChange }) {
    const set = (k, v) => onChange({ ...value, [k]: v });
    return (
        <>
            <div className="rx_row">
                <div>
                    <label title={_t("What scripts call it: lowercase letters, digits and hyphens.")}>{_t("Name")}</label>
                    <input type="text" value={value.name} placeholder="velvet-drone"
                           onChange={(ev) => set("name", ev.target.value.toLowerCase())} />
                </div>
                <div>
                    <label title={_t("Which directive plays it: a looping bed, a looping music layer that can play alongside a bed, or a one-shot effect.")}>
                        {_t("Kind")}
                    </label>
                    <select value={value.kind} onChange={(ev) => set("kind", ev.target.value)}>
                        {Object.entries(kinds).map(([k, label]) => <option key={k} value={k}>{_t(label)}</option>)}
                    </select>
                </div>
                <div>
                    <label title={_t("Default loudness change in dB, from -24 to 12. A script's own level adds to it.")}>{_t("Default level (dB)")}</label>
                    <input type="number" min="-24" max="12" step="1" value={value.level}
                           onChange={(ev) => set("level", ev.target.value)} />
                </div>
            </div>
            <label title={_t("Companions read this to decide when to use the sound, so say what it sounds like and what it suits.")}>
                {_t("Description")}
            </label>
            <input type="text" value={value.description}
                   placeholder={_t("e.g. 'slow, warm synth pad, dreamy; good under an induction'")}
                   onChange={(ev) => set("description", ev.target.value)} />
            <label title={_t("For your own records: who made it, where it came from, its licence.")}>{_t("Credit / licence")}</label>
            <input type="text" value={value.credit} placeholder={_t("e.g. 'Kevin MacLeod, CC BY 4.0, incompetech.com'")}
                   onChange={(ev) => set("credit", ev.target.value)} />
        </>
    );
}

export default function SoundLibrary({ sounds, kinds, onChange }) {
    const [adding, setAdding] = useState(null);   // {…fields, file}
    const [editing, setEditing] = useState(null); // {id, …fields}
    const [busy, setBusy] = useState(false);
    const fileRef = useRef(null);

    const pickFile = (file) => {
        if (!file) return;
        setAdding((a) => ({ ...(a || BLANK), file, name: (a && a.name) || slug(file.name) }));
    };

    const upload = async () => {
        setBusy(true);
        try {
            const fd = new FormData();
            for (const k of ["name", "kind", "description", "level", "credit"]) fd.append(k, String(adding[k] ?? ""));
            fd.append("file", adding.file, adding.file.name);
            const resp = await fetch("/api/audio/sounds/upload", { method: "POST", body: fd, credentials: "same-origin" });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body?.error?.message || `Upload failed (${resp.status})`);
            onChange(body);
            setAdding(null);
        } catch (e) {
            notification.add(e?.message || _t("Upload failed"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const saveEdit = async () => {
        setBusy(true);
        try {
            onChange(await rpc("/api/audio/sounds/save", editing));
            setEditing(null);
        } catch (e) {
            notification.add(e?.message || _t("Could not save the sound"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const remove = async (s) => {
        if (!(await confirmAsk(_t("Delete the sound '%s'? Scripts that use it will render without it, with a warning.", s.name)))) return;
        try {
            onChange(await rpc("/api/audio/sounds/delete", { id: s.id }));
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    return (
        <section>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <h3 style={{ margin: 0 }}><i className="fa fa-music" /> {_t("Your sounds")}</h3>
                {!adding && (
                    <button className="btn btn-sm" style={{ marginLeft: "auto" }}
                            onClick={() => { setAdding({ ...BLANK }); setTimeout(() => fileRef.current?.click(), 0); }}>
                        <i className="fa fa-upload" /> {_t("Add a sound")}
                    </button>
                )}
            </div>
            <p className="text-muted small" style={{ margin: "0.4rem 0 0.6rem" }}>
                {_t("Upload your own beds, music and sound effects (WAV, FLAC, OGG or MP3). Scripts call them by name, and companions see each one with your description in their guide, so they can use it in voice messages. Only upload audio you have the rights to use.")}
            </p>
            <p className="text-muted small" style={{ margin: "0 0 0.6rem" }}>
                {_t("Beds and music loop under the voice until changed: a new {bed NAME} or {music NAME} crossfades to it, and {bed off} or {music off} stops it (add fade=10s for a slower fade). A sound effect plays once, and by default the script waits for it to finish so it is heard on its own. Add a length to cut it short ({sound thunder 5s}), or add under to play it beneath the next lines without waiting ({sound rain under}).")}
            </p>
            {adding && (
                <div className="rx_agent_editor rx_studio_sound_form">
                    <label>{_t("File")}</label>
                    <input ref={fileRef} type="file" accept="audio/*,.wav,.flac,.ogg,.mp3"
                           onChange={(ev) => pickFile(ev.target.files?.[0])} />
                    <SoundFields value={adding} kinds={kinds} onChange={setAdding} />
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
                        <button className="btn btn-sm btn-primary" disabled={busy || !adding.file || !adding.name} onClick={upload}>
                            {busy ? <><i className="fa fa-spinner fa-spin" /> {_t("Uploading…")}</> : _t("Add sound")}
                        </button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => setAdding(null)}>{_t("Cancel")}</button>
                    </div>
                </div>
            )}
            {!sounds.length && !adding && (
                <p className="text-muted small">{_t("No sounds yet.")}</p>
            )}
            {sounds.map((s) => (editing && editing.id === s.id) ? (
                <div key={s.id} className="rx_agent_editor rx_studio_sound_form">
                    <SoundFields value={editing} kinds={kinds} onChange={setEditing} />
                    <p className="text-muted small" style={{ margin: "0.4rem 0 0" }}>
                        {_t("Renaming breaks scripts that call the old name; they render without it, with a warning.")}
                    </p>
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
                        <button className="btn btn-sm btn-primary" disabled={busy || !editing.name} onClick={saveEdit}>{_t("Save")}</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>{_t("Cancel")}</button>
                    </div>
                </div>
            ) : (
                <div key={s.id} className="rx_studio_rec">
                    <div className="rx_studio_rec_head">
                        <code>{USE[s.kind].replace("%s", s.name)}</code>
                        <span className="rx_studio_badge">{_t(kinds[s.kind])}</span>
                        <span className="text-muted small">
                            {formatClock(s.duration_seconds)}{s.level ? ` · ${s.level > 0 ? "+" : ""}${s.level} dB` : ""}
                        </span>
                        <span style={{ marginLeft: "auto", display: "flex", gap: "0.6rem" }}>
                            <button className="btn btn-sm btn-link p-0" title={_t("Edit")}
                                    onClick={() => setEditing({ id: s.id, name: s.name, kind: s.kind, description: s.description,
                                                                level: s.level, credit: s.credit })}>
                                <i className="fa fa-pencil" />
                            </button>
                            <button className="btn btn-sm btn-link p-0" title={_t("Delete")} onClick={() => remove(s)}>
                                <i className="fa fa-trash-o" />
                            </button>
                        </span>
                    </div>
                    {(s.description || s.credit) && (
                        <div className="text-muted small" style={{ marginTop: "0.2rem" }}>
                            {s.description}{s.description && s.credit ? " · " : ""}{s.credit && <em>{s.credit}</em>}
                        </div>
                    )}
                    <audio src={s.file_path} controls preload="none" />
                </div>
            ))}
        </section>
    );
}
