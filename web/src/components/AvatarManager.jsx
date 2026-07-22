import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";

/** Avatar manager — create/edit/delete avatar packs from the desktop UI.
 *  Round-trips through the manifest: uploads land in the pack folder, Save
 *  writes avatar.json and the server re-scans. Bundled avatars are read-only.
 *
 *  Background presets — keys must match BACKGROUND_PRESETS in
 *  services/avatar_renderer.js. */
const PRESETS = [
    "gradient_indigo", "gradient_slate", "gradient_studio",
    "vignette_charcoal", "vignette_studio", "vignette_navy",
    "solid_dark", "solid_light",
];

const BLANK_MANIFEST = { name: "", vrm: "", vrma_idle: "", outfits: [], gestures: [], backgrounds: [] };

export default function AvatarManager({ onChange }) {
    const [list, setList] = useState([]);
    const [editing, setEditing] = useState(null); // { pack_key, manifest, files }
    const [busy, setBusy] = useState(false);

    const load = async () => {
        try {
            setList(await rpc("/api/avatars/manage_list", {}));
        } catch (e) {
            notification.add(e?.message || _t("Could not load avatars"), { type: "danger" });
        }
    };
    useEffect(() => { load(); }, []);

    const startNew = async () => {
        try {
            // Allocate an empty pack up front so uploads have a folder to land
            // in; the name is collected in the form (required on save).
            const r = await rpc("/api/avatars/create", {});
            setEditing({
                pack_key: r.pack_key,
                manifest: { ...BLANK_MANIFEST, name: "" },
                files: { vrm: [], vrma: [], scene: [], image: [] },
                isNew: true,
            });
        } catch (e) {
            notification.add(e?.message || _t("Create failed"), { type: "danger" });
        }
    };

    const startEdit = async (a) => {
        try {
            const r = await rpc("/api/avatars/get", { pack_key: a.pack_key });
            setEditing({
                pack_key: a.pack_key,
                manifest: { ...BLANK_MANIFEST, ...r.manifest },
                files: r.files,
                isNew: false,
            });
        } catch (e) {
            notification.add(e?.message || _t("Could not open avatar"), { type: "danger" });
        }
    };

    const cancelEdit = async () => {
        // A brand-new avatar that was never saved leaves an orphan folder —
        // clean it up on cancel.
        if (editing?.isNew) {
            try { await rpc("/api/avatars/delete", { pack_key: editing.pack_key }); } catch (e) { /* */ }
        }
        setEditing(null);
        load();
    };

    const save = async () => {
        if (!editing.manifest.name?.trim()) {
            notification.add(_t("Give the avatar a name."), { type: "warning" });
            return;
        }
        if (!editing.manifest.vrm) {
            notification.add(_t("Upload a main VRM file."), { type: "warning" });
            return;
        }
        setBusy(true);
        try {
            const r = await rpc("/api/avatars/save", {
                pack_key: editing.pack_key,
                manifest: editing.manifest,
                is_new: editing.isNew,
            });
            notification.add(_t("%s saved to data/avatars/%s/", editing.manifest.name, r.pack_key), { type: "info" });
            setEditing(null);
            load();
            onChange?.();
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const remove = async (a) => {
        if (!window.confirm(_t("Delete avatar %s? Companions using it lose their avatar. This removes the pack folder and its files.", a.name))) return;
        try {
            await rpc("/api/avatars/delete", { pack_key: a.pack_key });
            notification.add(_t("%s deleted.", a.name), { type: "info" });
            load();
            onChange?.();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    if (editing) {
        return (
            <AvatarEditor editing={editing} setEditing={setEditing}
                          busy={busy} save={save} cancel={cancelEdit} />
        );
    }

    return (
        <div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
                <button className="btn btn-sm btn-primary" onClick={startNew}>
                    <i className="fa fa-plus" /> {_t("New avatar")}
                </button>
            </div>
            {list.map((a) => (
                <div key={a.id} className="rx_memory_row">
                    <strong>{a.name}</strong>
                    <span className="rx_memory_content text-muted small">
                        {a.outfit_count} {_t("outfits")} · {a.gesture_count} {_t("gestures")} · {a.background_count} {_t("backgrounds")}
                        {a.used_by ? ` · ${_t("used by")} ${a.used_by}` : ""}
                    </span>
                    {a.editable ? (
                        <>
                            <button className="btn btn-sm btn-link p-0" onClick={() => startEdit(a)}>{_t("Edit")}</button>
                            <button className="btn btn-sm btn-link p-0" title={_t("Delete avatar")} onClick={() => remove(a)}>
                                <i className="fa fa-trash-o" />
                            </button>
                        </>
                    ) : (
                        <span className="rx_memory_meta" title={_t("Bundled avatars ship with the app and are read-only. Create a new avatar to customize.")}>
                            <i className="fa fa-lock" /> {_t("bundled")}
                        </span>
                    )}
                </div>
            ))}
            <p className="text-muted small" style={{ marginTop: "0.6rem" }}>
                {_t("New and edited avatars are saved as packs under")} <code>data/avatars/</code> — {_t("shareable folders anyone can drop into another install. Bundled avatars are read-only.")}
            </p>
        </div>
    );
}

/** Upload a file to the pack, set a manifest field to the returned filename. */
function useUploader(packKey) {
    const [uploading, setUploading] = useState(false);
    const upload = async (kind, file) => {
        setUploading(true);
        try {
            const fd = new FormData();
            fd.append("pack_key", packKey);
            fd.append("kind", kind);
            fd.append("file", file, file.name);
            const resp = await fetch("/api/avatars/upload", { method: "POST", body: fd, credentials: "same-origin" });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body?.error?.message || `Upload failed (${resp.status})`);
            return body.filename;
        } finally {
            setUploading(false);
        }
    };
    return { upload, uploading };
}

/** A labelled file input that uploads on selection and shows the current file. */
function FileField({ label, kind, packKey, value, accept, onUploaded }) {
    const ref = useRef(null);
    const { upload, uploading } = useUploader(packKey);
    const pick = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = "";
        if (!file) return;
        try {
            const fn = await upload(kind, file);
            onUploaded(fn);
        } catch (e) {
            notification.add(e?.message || _t("Upload failed"), { type: "danger" });
        }
    };
    return (
        <div>
            {label && <label>{label}</label>}
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <button className="btn btn-sm" disabled={uploading} onClick={() => ref.current?.click()}>
                    <i className={uploading ? "fa fa-spinner fa-spin" : "fa fa-upload"} /> {value ? _t("Replace") : _t("Upload")}
                </button>
                <span className="text-muted small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {value || _t("(none)")}
                </span>
                <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={pick} />
            </div>
        </div>
    );
}

function AvatarEditor({ editing, setEditing, busy, save, cancel }) {
    const { pack_key, manifest } = editing;
    const setM = (patch) => setEditing({ ...editing, manifest: { ...manifest, ...patch } });

    const setList = (key, idx, patch) => {
        const arr = [...(manifest[key] || [])];
        arr[idx] = { ...arr[idx], ...patch };
        setM({ [key]: arr });
    };
    const addItem = (key, item) => setM({ [key]: [...(manifest[key] || []), item] });
    const removeItem = (key, idx) => setM({ [key]: (manifest[key] || []).filter((_, i) => i !== idx) });

    // Scene backgrounds carry an [x,y,z] offset; patch one axis in place.
    const setOffset = (idx, axis, val) => {
        const cur = (manifest.backgrounds[idx].offset || [0, 0, 0]).slice();
        cur[axis] = Number.isFinite(val) ? val : 0;
        setList("backgrounds", idx, { offset: cur });
    };

    // Combo gestures carry [x,y,z] / [yaw,pitch,roll] triples; patch one slot.
    const setVec = (key, idx, field, axis, val) => {
        const cur = ((manifest[key][idx][field]) || [0, 0, 0]).slice();
        while (cur.length < 3) cur.push(0);
        cur[axis] = Number.isFinite(val) ? val : 0;
        setList(key, idx, { [field]: cur });
    };

    return (
        <div>
            <div className="rx_row">
                <div>
                    <label>{_t("Avatar name")}</label>
                    <input type="text" value={manifest.name || ""}
                           onChange={(ev) => setM({ name: ev.target.value })} />
                </div>
                <FileField label={_t("Main VRM (required)")} kind="vrm" packKey={pack_key}
                           value={manifest.vrm} accept=".vrm"
                           onUploaded={(fn) => setM({ vrm: fn })} />
                <FileField label={_t("Idle animation VRMA (optional)")} kind="vrma" packKey={pack_key}
                           value={manifest.vrma_idle} accept=".vrma"
                           onUploaded={(fn) => setM({ vrma_idle: fn })} />
            </div>
            <p className="text-muted small rx_pack_path">
                <i className="fa fa-folder-o" /> {_t("Pack folder:")}{" "}
                <code>data/avatars/{editing.isNew ? "…" : pack_key}/</code>
                {editing.isNew
                    ? " — " + _t("named after this avatar when you save.")
                    : " — " + _t("fixed folder id; renaming the avatar above doesn't move it.")}
            </p>

            {/* Outfits */}
            <Section title={_t("Outfits")}
                     onAdd={() => addItem("outfits", { name: "", vrm: "", description: "" })}>
                {(manifest.outfits || []).map((o, i) => (
                    <div key={i} className="rx_subrow">
                        <input type="text" placeholder={_t("Name")} value={o.name || ""}
                               onChange={(ev) => setList("outfits", i, { name: ev.target.value })} />
                        <FileField kind="vrm" packKey={pack_key} value={o.vrm} accept=".vrm"
                                   onUploaded={(fn) => setList("outfits", i, { vrm: fn })} />
                        <input type="text" placeholder={_t("Description (fed to the LLM — when to wear it)")}
                               value={o.description || ""}
                               onChange={(ev) => setList("outfits", i, { description: ev.target.value })} />
                        <button className="btn btn-sm btn-link p-0" onClick={() => removeItem("outfits", i)}>
                            <i className="fa fa-trash-o" />
                        </button>
                    </div>
                ))}
            </Section>

            {/* Gestures (solo) */}
            <Section title={_t("Custom gestures")}
                     onAdd={() => addItem("gestures", { enum: "", vrma: "", description: "", loop: false })}>
                {(manifest.gestures || []).map((g, i) => ({ g, i }))
                    .filter(({ g }) => g.type !== "combo")
                    .map(({ g, i }) => (
                    <div key={i} className="rx_subrow">
                        <input type="text" placeholder={_t("enum (e.g. wave_hello)")} value={g.enum || ""}
                               onChange={(ev) => setList("gestures", i, { enum: ev.target.value })} />
                        <FileField kind="vrma" packKey={pack_key} value={g.vrma} accept=".vrma"
                                   onUploaded={(fn) => setList("gestures", i, { vrma: fn })} />
                        <input type="text" placeholder={_t("Description (when to use it)")} value={g.description || ""}
                               onChange={(ev) => setList("gestures", i, { description: ev.target.value })} />
                        <label className="rx_check" style={{ margin: 0 }}>
                            <input type="checkbox" checked={!!g.loop}
                                   onChange={(ev) => setList("gestures", i, { loop: ev.target.checked })} />
                            <span>{_t("loop")}</span>
                        </label>
                        <button className="btn btn-sm btn-link p-0" onClick={() => removeItem("gestures", i)}>
                            <i className="fa fa-trash-o" />
                        </button>
                    </div>
                ))}
            </Section>

            {/* Combo (two-character) gestures */}
            <Section title={_t("Combo gestures (two characters)")}
                     onAdd={() => addItem("gestures", {
                         enum: "", type: "combo", vrma: "", description: "", loop: false,
                         partner_avatar: "", partner_vrm: "", partner_vrma: "",
                         base_offset: [0, 0, 0], base_rotation: [0, 0, 0],
                         partner_offset: [0.6, 0, 0], partner_rotation: [0, 0, 0],
                         partner_scale: 1.0,
                     })}>
                {(manifest.gestures || []).map((g, i) => ({ g, i }))
                    .filter(({ g }) => g.type === "combo")
                    .map(({ g, i }) => (
                    <div key={i} className="rx_subrow rx_subrow--combo" style={{ flexWrap: "wrap" }}>
                        <input type="text" placeholder={_t("enum (e.g. dance_together)")} value={g.enum || ""}
                               onChange={(ev) => setList("gestures", i, { enum: ev.target.value })} />
                        <FileField label={_t("Base VRMA")} kind="vrma" packKey={pack_key} value={g.vrma} accept=".vrma"
                                   onUploaded={(fn) => setList("gestures", i, { vrma: fn })} />
                        <input type="text" placeholder={_t("Description (when to use it)")} value={g.description || ""}
                               onChange={(ev) => setList("gestures", i, { description: ev.target.value })} />
                        <input type="text" value={g.partner_avatar || ""}
                               placeholder={_t("Partner avatar name (optional — else upload a VRM)")}
                               title={_t("Existing avatar to load as the second character (name or pack folder). Leave empty to upload a dedicated Partner VRM instead.")}
                               onChange={(ev) => setList("gestures", i, { partner_avatar: ev.target.value })} />
                        {!(g.partner_avatar || "").trim() && (
                            <FileField label={_t("Partner VRM")} kind="vrm" packKey={pack_key} value={g.partner_vrm} accept=".vrm"
                                       onUploaded={(fn) => setList("gestures", i, { partner_vrm: fn })} />
                        )}
                        <FileField label={_t("Partner VRMA")} kind="vrma" packKey={pack_key} value={g.partner_vrma} accept=".vrma"
                                   onUploaded={(fn) => setList("gestures", i, { partner_vrma: fn })} />
                        <span className="rx_scene_xform"
                              title={_t("Base avatar placement during the combo. Offsets in metres; rotations in degrees applied yaw → pitch → roll (yaw 0 = facing the camera; pitch 90 = lying on the back — pair with a positive Y offset since models pivot at their feet).")}>
                            base
                            {["x", "y", "z"].map((ax, k) => (
                                <label key={ax}>{ax}<input type="number" step="0.1"
                                    value={(g.base_offset || [0, 0, 0])[k]}
                                    onChange={(ev) => setVec("gestures", i, "base_offset", k, parseFloat(ev.target.value))} /></label>
                            ))}
                            {["yaw", "pitch", "roll"].map((ax, k) => (
                                <label key={ax}>{ax}<input type="number" step="5"
                                    value={(g.base_rotation || [0, 0, 0])[k]}
                                    onChange={(ev) => setVec("gestures", i, "base_rotation", k, parseFloat(ev.target.value))} /></label>
                            ))}
                        </span>
                        <span className="rx_scene_xform"
                              title={_t("Partner placement during the combo — same conventions as the base avatar, plus a uniform scale.")}>
                            partner
                            {["x", "y", "z"].map((ax, k) => (
                                <label key={ax}>{ax}<input type="number" step="0.1"
                                    value={(g.partner_offset || [0.6, 0, 0])[k]}
                                    onChange={(ev) => setVec("gestures", i, "partner_offset", k, parseFloat(ev.target.value))} /></label>
                            ))}
                            {["yaw", "pitch", "roll"].map((ax, k) => (
                                <label key={ax}>{ax}<input type="number" step="5"
                                    value={(g.partner_rotation || [0, 0, 0])[k]}
                                    onChange={(ev) => setVec("gestures", i, "partner_rotation", k, parseFloat(ev.target.value))} /></label>
                            ))}
                            <label>scale<input type="number" step="0.05"
                                value={g.partner_scale ?? 1}
                                onChange={(ev) => setList("gestures", i, { partner_scale: parseFloat(ev.target.value) || 1 })} /></label>
                        </span>
                        <label className="rx_check" style={{ margin: 0 }}
                               title={_t("Looping combos: both clips should have the same duration or they drift out of phase with each repeat.")}>
                            <input type="checkbox" checked={!!g.loop}
                                   onChange={(ev) => setList("gestures", i, { loop: ev.target.checked })} />
                            <span>{_t("loop")}</span>
                        </label>
                        <button className="btn btn-sm btn-link p-0" onClick={() => removeItem("gestures", i)}>
                            <i className="fa fa-trash-o" />
                        </button>
                    </div>
                ))}
                <p className="text-muted small" style={{ margin: "0.25rem 0 0" }}>
                    {_t("Combo gestures animate two characters at once: this avatar plays the Base VRMA while a second VRM — an existing avatar or a dedicated upload — plays the Partner VRMA in sync (dancing together, hugging, …). The partner unloads when the gesture ends or is replaced.")}
                </p>
            </Section>

            {/* Backgrounds */}
            <Section title={_t("Backgrounds")}
                     onAdd={() => addItem("backgrounds", { name: "", type: "static", preset: "vignette_charcoal", is_default: false })}>
                {(manifest.backgrounds || []).map((b, i) => (
                    <div key={i} className="rx_subrow rx_subrow--bg">
                        <input type="text" placeholder={_t("Name")} value={b.name || ""}
                               onChange={(ev) => setList("backgrounds", i, { name: ev.target.value })} />
                        <select value={b.type || "static"}
                                onChange={(ev) => setList("backgrounds", i, { type: ev.target.value })}>
                            <option value="static">{_t("Preset")}</option>
                            <option value="image">{_t("Image")}</option>
                            <option value="scene">{_t("3D scene (GLB)")}</option>
                        </select>
                        {b.type === "static" && (
                            <select value={b.preset || ""}
                                    onChange={(ev) => setList("backgrounds", i, { preset: ev.target.value })}>
                                {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        )}
                        {b.type === "image" && (
                            <FileField kind="image" packKey={pack_key} value={b.image} accept=".png,.jpg,.jpeg,.webp"
                                       onUploaded={(fn) => setList("backgrounds", i, { image: fn })} />
                        )}
                        {b.type === "scene" && (
                            <>
                                <FileField kind="scene" packKey={pack_key} value={b.glb} accept=".glb,.gltf"
                                           onUploaded={(fn) => setList("backgrounds", i, { glb: fn })} />
                                <span className="rx_scene_xform" title={_t("Placement of the GLB scene, in metres (avatar ≈ 1.5 m tall). Scale, X/Y/Z offset, and Y-axis rotation in degrees.")}>
                                    <label>scale<input type="number" step="0.1" value={b.scale ?? 1}
                                           onChange={(ev) => setList("backgrounds", i, { scale: parseFloat(ev.target.value) || 1 })} /></label>
                                    <label>x<input type="number" step="0.1" value={(b.offset || [0, 0, 0])[0]}
                                           onChange={(ev) => setOffset(i, 0, parseFloat(ev.target.value))} /></label>
                                    <label>y<input type="number" step="0.1" value={(b.offset || [0, 0, 0])[1]}
                                           onChange={(ev) => setOffset(i, 1, parseFloat(ev.target.value))} /></label>
                                    <label>z<input type="number" step="0.1" value={(b.offset || [0, 0, 0])[2]}
                                           onChange={(ev) => setOffset(i, 2, parseFloat(ev.target.value))} /></label>
                                    <label>y°<input type="number" step="1" value={b.rotation_y ?? 0}
                                           onChange={(ev) => setList("backgrounds", i, { rotation_y: parseFloat(ev.target.value) || 0 })} /></label>
                                </span>
                            </>
                        )}
                        <label className="rx_check" style={{ margin: 0 }}>
                            <input type="checkbox" checked={!!b.is_default}
                                   onChange={(ev) => setList("backgrounds", i, { is_default: ev.target.checked })} />
                            <span>{_t("default")}</span>
                        </label>
                        <button className="btn btn-sm btn-link p-0" onClick={() => removeItem("backgrounds", i)}>
                            <i className="fa fa-trash-o" />
                        </button>
                    </div>
                ))}
            </Section>

            <div style={{ marginTop: "0.85rem", display: "flex", gap: "0.5rem" }}>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{_t("Save avatar")}</button>
                <button className="btn btn-sm" onClick={cancel}>{_t("Cancel")}</button>
            </div>
        </div>
    );
}

function Section({ title, onAdd, children }) {
    return (
        <div className="rx_editor_section">
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{title}</span>
                <button className="btn btn-sm" onClick={onAdd}><i className="fa fa-plus" /> {_t("Add")}</button>
            </label>
            {children}
        </div>
    );
}
