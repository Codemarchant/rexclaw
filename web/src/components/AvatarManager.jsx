import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { confirmAsk } from "../lib/confirm";
import Pager, { usePager } from "./Pager.jsx";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { EditorBar } from "./UnsavedUI.jsx";

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

/** Numeric input that doesn't fight the keyboard. A plain controlled number
 *  input re-renders from the parsed value on every keystroke, so an
 *  in-progress "-" or "" parses to NaN, snaps the field back to 0, and makes
 *  typing "-5" impossible. This keeps the box as free text while focused,
 *  commits every valid parse upward, and only snaps back on blur when what's
 *  left isn't a number. */
function NumField({ value, step, onCommit }) {
    const [text, setText] = useState(String(value ?? 0));
    const focused = useRef(false);
    useEffect(() => {
        // Follow external changes (switching rows, loading a manifest) but
        // never clobber what the user is mid-typing.
        if (!focused.current && parseFloat(text) !== (value ?? 0)) setText(String(value ?? 0));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    return (
        <input type="number" step={step} value={text}
               onFocus={() => { focused.current = true; }}
               onChange={(ev) => {
                   setText(ev.target.value);
                   const n = parseFloat(ev.target.value);
                   if (!Number.isNaN(n)) onCommit(n);
               }}
               onBlur={() => {
                   focused.current = false;
                   const n = parseFloat(text);
                   setText(String(Number.isNaN(n) ? (value ?? 0) : n));
               }} />
    );
}

export default function AvatarManager({ onChange, active = true }) {
    const [list, setList] = useState([]);
    const [editing, setEditing] = useState(null); // { pack_key, manifest, files }
    const [busy, setBusy] = useState(false);
    const [dupFor, setDupFor] = useState(null);  // avatar id with the inline duplicate-name input open
    const [dupName, setDupName] = useState("");
    const [importingPack, setImportingPack] = useState(false);
    const [query, setQuery] = useState("");
    const packImportRef = useRef(null);

    const load = async () => {
        try {
            setList(await rpc("/api/avatars/manage_list", {}));
        } catch (e) {
            notification.add(e?.message || _t("Could not load avatars"), { type: "danger" });
        }
    };
    useEffect(() => { if (active) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [active]);

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
            return false;
        }
        if (!editing.manifest.vrm) {
            notification.add(_t("Upload a main VRM file."), { type: "warning" });
            return false;
        }
        setBusy(true);
        try {
            await rpc("/api/avatars/save", {
                pack_key: editing.pack_key,
                manifest: editing.manifest,
                is_new: editing.isNew,
            });
            setEditing(null);
            load();
            onChange?.();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
            return false;
        } finally {
            setBusy(false);
        }
    };

    // Unsaved-changes guard for the open avatar editor: dirty when the draft
    // manifest differs from the snapshot captured on open, or it's a brand-new
    // (never-saved) pack — so leaving the tab prompts Save / Discard (Discard
    // runs cancelEdit, which cleans up an orphan folder) instead of silently
    // stranding the edit.
    const editBaseline = useRef(null);
    useEffect(() => {
        if (editing && editBaseline.current === null) editBaseline.current = JSON.stringify(editing.manifest);
        else if (!editing) editBaseline.current = null;
    }, [editing]);
    const editDirty = !!editing && (editing.isNew
        || (editBaseline.current !== null && JSON.stringify(editing.manifest) !== editBaseline.current));
    useUnsavedGuard(active, editDirty, save, cancelEdit);

    // The name chosen here also names the pack folder (folders only follow
    // the display name at creation), so ask up front instead of hardcoding
    // "<name> - Copy" into the folder forever. Inline input rather than
    // window.prompt(): Electron doesn't implement prompt(), so the desktop
    // app would throw before the RPC ever fired.
    const startDuplicate = (a) => {
        setDupFor(a.id);
        setDupName(`${a.name} Copy`);
    };

    const confirmDuplicate = async (a) => {
        const name = dupName.trim();
        if (!name) return;
        try {
            await rpc("/api/avatars/duplicate", { pack_key: a.pack_key, name });
            setDupFor(null);
            load();
            onChange?.();
        } catch (e) {
            notification.add(e?.message || _t("Duplicate failed"), { type: "danger" });
        }
    };

    const duplicateControls = (a) => (
        dupFor === a.id ? (
            <span style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center" }}>
                <input
                    type="text"
                    autoFocus
                    value={dupName}
                    style={{ width: "11rem", padding: "0.15rem 0.4rem" }}
                    title={_t("Name for the copy (also names the pack folder)")}
                    onChange={(e) => setDupName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") confirmDuplicate(a);
                        if (e.key === "Escape") setDupFor(null);
                    }}
                />
                <button className="btn btn-sm btn-link p-0" title={_t("Create copy")}
                        disabled={!dupName.trim()} onClick={() => confirmDuplicate(a)}>
                    <i className="fa fa-check" />
                </button>
                <button className="btn btn-sm btn-link p-0" title={_t("Cancel")}
                        onClick={() => setDupFor(null)}>
                    <i className="fa fa-times" />
                </button>
            </span>
        ) : (
            <button className="btn btn-sm btn-link p-0"
                    title={_t("Duplicate — make an editable copy (e.g. to add custom gestures to a bundled avatar)")}
                    onClick={() => startDuplicate(a)}>
                <i className="fa fa-clone" />
            </button>
        )
    );

    // Pack zip export: plain GET download so the browser/Electron streams it
    // to disk — VRM packs run to hundreds of MB.
    const exportPack = (a) => {
        const link = document.createElement("a");
        link.href = `/api/avatars/export?pack_key=${encodeURIComponent(a.pack_key)}`;
        link.click();
    };

    const importPack = async (file) => {
        setImportingPack(true);
        try {
            const fd = new FormData();
            fd.append("file", file, file.name);
            const resp = await fetch("/api/avatars/import", { method: "POST", body: fd, credentials: "same-origin" });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body?.error?.message || `Import failed (${resp.status})`);
            notification.add(_t("%s imported.", body.name), { type: "success" });
            load();
            onChange?.();
        } catch (e) {
            notification.add(e?.message || _t("Import failed"), { type: "danger" });
        } finally {
            setImportingPack(false);
        }
    };

    const remove = async (a) => {
        if (!(await confirmAsk(_t("Delete avatar %s? Companions using it lose their avatar. This removes the pack folder and its files.", a.name)))) return;
        try {
            await rpc("/api/avatars/delete", { pack_key: a.pack_key });
            load();
            onChange?.();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const q = query.trim().toLowerCase();
    const visibleList = q ? list.filter((a) => (a.name || "").toLowerCase().includes(q)) : list;
    // Hook lives above the editor early-return so it runs every render.
    const pager = usePager(visibleList.length);

    if (editing) {
        return (
            <AvatarEditor editing={editing} setEditing={setEditing}
                          busy={busy} save={save} cancel={cancelEdit} dirty={editDirty} />
        );
    }


    return (
        <section>
            <h3><i className="fa fa-user-circle-o" /> {_t("Avatars")}</h3>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <input
                    type="text"
                    placeholder={_t("Search avatars…")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ width: "12rem" }}
                />
                <button className="btn btn-sm" disabled={importingPack}
                        title={_t("Import an avatar pack (.zip) — a zipped pack folder from any rexclaw install")}
                        onClick={() => packImportRef.current?.click()}>
                    <i className="fa fa-upload" /> {importingPack ? _t("Importing…") : _t("Import pack")}
                </button>
                <button className="btn btn-sm btn-primary" onClick={startNew}>
                    <i className="fa fa-plus" /> {_t("New avatar")}
                </button>
                <input
                    ref={packImportRef}
                    type="file"
                    accept=".zip,application/zip"
                    style={{ display: "none" }}
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) importPack(file);
                    }}
                />
            </div>
            {!!q && !visibleList.length && (
                <p className="text-muted small">{_t("No matches.")}</p>
            )}
            <Pager pager={pager} />
            {pager.slice(visibleList).map((a) => (
                <div key={a.id} className="rx_memory_row">
                    <strong>{a.name}</strong>
                    <span className="rx_memory_content text-muted small">
                        {a.outfit_count} {_t("outfits")} · {a.gesture_count} {_t("gestures")} · {a.background_count} {_t("backgrounds")}
                        {a.used_by ? ` · ${_t("used by")} ${a.used_by}` : ""}
                    </span>
                    {a.editable ? (
                        <>
                            <button className="btn btn-sm btn-link p-0" onClick={() => startEdit(a)}>{_t("Edit")}</button>
                            {a.pack_key && duplicateControls(a)}
                            {a.pack_key && (
                                <button className="btn btn-sm btn-link p-0" title={_t("Export as avatar pack (.zip)")}
                                        onClick={() => exportPack(a)}>
                                    <i className="fa fa-download" />
                                </button>
                            )}
                            <button className="btn btn-sm btn-link p-0" title={_t("Delete avatar")} onClick={() => remove(a)}>
                                <i className="fa fa-trash-o" />
                            </button>
                        </>
                    ) : (
                        <>
                            {a.pack_key && duplicateControls(a)}
                            {a.pack_key && (
                                <button className="btn btn-sm btn-link p-0" title={_t("Export as avatar pack (.zip)")}
                                        onClick={() => exportPack(a)}>
                                    <i className="fa fa-download" />
                                </button>
                            )}
                            <span className="rx_memory_meta" title={_t("Bundled avatars ship with the app and are read-only. Duplicate one to customize it.")}>
                                <i className="fa fa-lock" /> {_t("bundled")}
                            </span>
                        </>
                    )}
                </div>
            ))}
            <p className="text-muted small" style={{ marginTop: "0.6rem" }}>
                {_t("New and edited avatars are saved as packs under")} <code>data/avatars/</code> — {_t("shareable folders anyone can drop into another install. Bundled avatars are read-only.")}
            </p>
        </section>
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

/** A labelled file input that uploads on selection and shows the current file.
 *  `library` (optional): shared-asset records — matching-kind entries render
 *  as a "Library…" picker so one file in data/assets/ serves every avatar
 *  without a duplicate upload (the manifest stores its absolute web path). */
function FileField({ label, kind, packKey, value, accept, onUploaded, library }) {
    const ref = useRef(null);
    const { upload, uploading } = useUploader(packKey);
    const libraryOptions = (library || []).filter((f) => f.kind === kind);
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
                {libraryOptions.length > 0 && (
                    <select className="rx_lib_select" value=""
                            title={_t("Pick from the shared asset library — files in data/assets/ plus bundled assets, usable by every avatar")}
                            onChange={(ev) => { if (ev.target.value) onUploaded(ev.target.value); }}>
                        <option value="">{_t("Library…")}</option>
                        {libraryOptions.map((f) => (
                            <option key={f.url} value={f.url}>
                                {f.name}{f.source === "bundled" ? " " + _t("(bundled)") : ""}
                            </option>
                        ))}
                    </select>
                )}
                <span className="text-muted small" title={value || undefined}
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {value || _t("(none)")}
                </span>
                <input ref={ref} type="file" accept={accept} style={{ display: "none" }} onChange={pick} />
            </div>
        </div>
    );
}

function AvatarEditor({ editing, setEditing, busy, save, cancel, dirty }) {
    const { pack_key, manifest } = editing;
    const setM = (patch) => setEditing({ ...editing, manifest: { ...manifest, ...patch } });

    // Shared asset library (data/assets + bundled glb/vrma) — one fetch per
    // editor open; FileFields filter it by their kind.
    const [library, setLibrary] = useState([]);
    useEffect(() => {
        rpc("/api/avatars/shared_assets", {}).then(setLibrary).catch(() => setLibrary([]));
    }, []);

    const setList = (key, idx, patch) => {
        const arr = [...(manifest[key] || [])];
        arr[idx] = { ...arr[idx], ...patch };
        setM({ [key]: arr });
    };
    // Prepend: new rows appear at the top of their list (matches the
    // memories view and every other list editor in the app).
    const addItem = (key, item) => setM({ [key]: [item, ...(manifest[key] || [])] });
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
        <>
            <section>
            <h3>
                <i className="fa fa-user-circle-o" />{" "}
                {editing.isNew ? _t("New avatar") : _t("Edit avatar")}
                {manifest.name ? ` — ${manifest.name}` : ""}
            </h3>
            <div className="rx_row">
                <div>
                    <label>{_t("Avatar name")}</label>
                    <input type="text" value={manifest.name || ""}
                           onChange={(ev) => setM({ name: ev.target.value })} />
                </div>
                <FileField library={library} label={_t("Main VRM (required)")} kind="vrm" packKey={pack_key}
                           value={manifest.vrm} accept=".vrm"
                           onUploaded={(fn) => setM({ vrm: fn })} />
                <FileField library={library} label={_t("Idle animation VRMA (optional)")} kind="vrma" packKey={pack_key}
                           value={manifest.vrma_idle} accept=".vrma"
                           onUploaded={(fn) => setM({ vrma_idle: fn })} />
                <label className="rx_check" style={{ alignSelf: "end" }}
                       title={_t("Emotions the companion sets fade back toward neutral after a few seconds. Turn off to hold each expression until the next one.")}>
                    <input type="checkbox" checked={manifest.emotion_decay !== false}
                           onChange={(ev) => setM({ emotion_decay: ev.target.checked })} />
                    <span>{_t("Fade emotions back to neutral")}</span>
                </label>
            </div>
            <p className="text-muted small rx_pack_path">
                <i className="fa fa-folder-o" /> {_t("Pack folder:")}{" "}
                <code>data/avatars/{editing.isNew ? "…" : pack_key}/</code>
                {editing.isNew
                    ? " — " + _t("named after this avatar when you save.")
                    : " — " + _t("fixed folder id; renaming the avatar above doesn't move it.")}
                {" "}
                <i className="fa fa-book" /> {_t("Shared files: drop them into")}{" "}
                <code>data/assets/</code> — {_t("every upload field's Library picker can then reference the same file from any avatar, no duplicate uploads.")}
            </p>
            </section>

            {/* Outfits */}
            <Section title={_t("Outfits")}
                     onAdd={() => addItem("outfits", { name: "", vrm: "", description: "" })}>
                {(manifest.outfits || []).map((o, i) => (
                    <div key={i} className="rx_subrow rx_subrow--outfit">
                        <input type="text" placeholder={_t("Name")} value={o.name || ""}
                               onChange={(ev) => setList("outfits", i, { name: ev.target.value })} />
                        <FileField library={library} kind="vrm" packKey={pack_key} value={o.vrm} accept=".vrm"
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
                    <div key={i} className="rx_subrow rx_subrow--gesture">
                        <input type="text" placeholder={_t("enum (e.g. wave_hello)")} value={g.enum || ""}
                               title={_t("Gesture name the model calls — lowercase letters, digits and underscores, starting with a letter (e.g. wave_hello, test_1).")}
                               onChange={(ev) => setList("gestures", i, { enum: ev.target.value })} />
                        <FileField library={library} kind="vrma" packKey={pack_key} value={g.vrma} accept=".vrma"
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
                <p className="text-muted small" style={{ margin: "0 0 0.25rem" }}>
                    {_t("Combo gestures animate two characters at once: this avatar plays the Base VRMA while a second VRM — an existing avatar or a dedicated upload — plays the Partner VRMA in sync (dancing together, hugging, …). The partner unloads when the gesture ends or is replaced.")}
                </p>
                {(manifest.gestures || []).map((g, i) => ({ g, i }))
                    .filter(({ g }) => g.type === "combo")
                    .map(({ g, i }) => (
                    <div key={i} className="rx_subrow rx_subrow--combo">
                        <div className="rx_combo_line">
                            <input type="text" className="rx_field_enum"
                                   placeholder={_t("enum (e.g. dance_together)")} value={g.enum || ""}
                                   title={_t("Gesture name the model calls — lowercase letters, digits and underscores, starting with a letter (e.g. dance_together).")}
                                   onChange={(ev) => setList("gestures", i, { enum: ev.target.value })} />
                            <FileField library={library} label={_t("Base VRMA")} kind="vrma" packKey={pack_key} value={g.vrma} accept=".vrma"
                                       onUploaded={(fn) => setList("gestures", i, { vrma: fn })} />
                            <input type="text" placeholder={_t("Description (when to use it)")} value={g.description || ""}
                                   onChange={(ev) => setList("gestures", i, { description: ev.target.value })} />
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
                        <div className="rx_combo_line">
                            <input type="text" className="rx_field_enum" value={g.partner_avatar || ""}
                                   placeholder={_t("Partner avatar name (optional — else upload a VRM)")}
                                   title={_t("Existing avatar to load as the second character (name or pack folder). Leave empty to upload a dedicated Partner VRM instead.")}
                                   onChange={(ev) => setList("gestures", i, { partner_avatar: ev.target.value })} />
                            {!(g.partner_avatar || "").trim() && (
                                <FileField library={library} label={_t("Partner VRM")} kind="vrm" packKey={pack_key} value={g.partner_vrm} accept=".vrm"
                                           onUploaded={(fn) => setList("gestures", i, { partner_vrm: fn })} />
                            )}
                            <FileField library={library} label={_t("Partner VRMA")} kind="vrma" packKey={pack_key} value={g.partner_vrma} accept=".vrma"
                                       onUploaded={(fn) => setList("gestures", i, { partner_vrma: fn })} />
                        </div>
                        <div className="rx_combo_line">
                        <span className="rx_scene_xform"
                              title={_t("Base avatar placement during the combo. Offsets in metres; rotations in degrees applied yaw → pitch → roll (yaw 0 = facing the camera; pitch 90 = lying on the back — pair with a positive Y offset since models pivot at their feet).")}>
                            base
                            {["x", "y", "z"].map((ax, k) => (
                                <label key={ax}>{ax}<NumField step="0.1"
                                    value={(g.base_offset || [0, 0, 0])[k]}
                                    onCommit={(n) => setVec("gestures", i, "base_offset", k, n)} /></label>
                            ))}
                            {["yaw", "pitch", "roll"].map((ax, k) => (
                                <label key={ax}>{ax}<NumField step="5"
                                    value={(g.base_rotation || [0, 0, 0])[k]}
                                    onCommit={(n) => setVec("gestures", i, "base_rotation", k, n)} /></label>
                            ))}
                        </span>
                        <span className="rx_scene_xform"
                              title={_t("Partner placement during the combo — same conventions as the base avatar, plus a uniform scale.")}>
                            partner
                            {["x", "y", "z"].map((ax, k) => (
                                <label key={ax}>{ax}<NumField step="0.1"
                                    value={(g.partner_offset || [0.6, 0, 0])[k]}
                                    onCommit={(n) => setVec("gestures", i, "partner_offset", k, n)} /></label>
                            ))}
                            {["yaw", "pitch", "roll"].map((ax, k) => (
                                <label key={ax}>{ax}<NumField step="5"
                                    value={(g.partner_rotation || [0, 0, 0])[k]}
                                    onCommit={(n) => setVec("gestures", i, "partner_rotation", k, n)} /></label>
                            ))}
                            <label>scale<NumField step="0.05"
                                value={g.partner_scale ?? 1}
                                onCommit={(n) => setList("gestures", i, { partner_scale: n })} /></label>
                        </span>
                        </div>
                    </div>
                ))}
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
                        <div className="rx_bg_controls">
                            {b.type === "static" && (
                                <select value={b.preset || ""}
                                        onChange={(ev) => setList("backgrounds", i, { preset: ev.target.value })}>
                                    {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                                </select>
                            )}
                            {b.type === "image" && (
                                <FileField library={library} kind="image" packKey={pack_key} value={b.image} accept=".png,.jpg,.jpeg,.webp"
                                           onUploaded={(fn) => setList("backgrounds", i, { image: fn })} />
                            )}
                            {b.type === "scene" && (
                                <FileField library={library} kind="scene" packKey={pack_key} value={b.glb} accept=".glb,.gltf"
                                           onUploaded={(fn) => setList("backgrounds", i, { glb: fn })} />
                            )}
                        </div>
                        <label className="rx_check" style={{ margin: 0 }}>
                            <input type="checkbox" checked={!!b.is_default}
                                   onChange={(ev) => setList("backgrounds", i, { is_default: ev.target.checked })} />
                            <span>{_t("default")}</span>
                        </label>
                        <button className="btn btn-sm btn-link p-0" onClick={() => removeItem("backgrounds", i)}>
                            <i className="fa fa-trash-o" />
                        </button>
                        {/* Direct grid child pinned to the controls column — gets its
                            own grid line under the file controls (see rx_subrow--bg). */}
                        {b.type === "scene" && (
                            <span className="rx_scene_xform" title={_t("Placement of the GLB scene, in metres (avatar ≈ 1.5 m tall). Scale, X/Y/Z offset, and Y-axis rotation in degrees.")}>
                                <label>scale<NumField step="0.1" value={b.scale ?? 1}
                                       onCommit={(n) => setList("backgrounds", i, { scale: n })} /></label>
                                <label>x<NumField step="0.1" value={(b.offset || [0, 0, 0])[0]}
                                       onCommit={(n) => setOffset(i, 0, n)} /></label>
                                <label>y<NumField step="0.1" value={(b.offset || [0, 0, 0])[1]}
                                       onCommit={(n) => setOffset(i, 1, n)} /></label>
                                <label>z<NumField step="0.1" value={(b.offset || [0, 0, 0])[2]}
                                       onCommit={(n) => setOffset(i, 2, n)} /></label>
                                <label>y°<NumField step="1" value={b.rotation_y ?? 0}
                                       onCommit={(n) => setList("backgrounds", i, { rotation_y: n })} /></label>
                            </span>
                        )}
                    </div>
                ))}
            </Section>

            <EditorBar
                dirty={dirty}
                saving={busy}
                onSave={save}
                onCancel={cancel}
                saveLabel={_t("Save avatar")}
                saveDisabled={!editing.manifest.name?.trim() || !editing.manifest.vrm}
                pinned />
        </>
    );
}

function Section({ title, onAdd, children }) {
    // NOT a <label> — a label wrapping the button makes a click anywhere in
    // the header row (including blank space) activate Add.
    return (
        <section>
            <div className="rx_section_head" style={{ margin: 0 }}>
                <h3 style={{ margin: 0 }}>{title}</h3>
                <button className="btn btn-sm" onClick={onAdd}><i className="fa fa-plus" /> {_t("Add")}</button>
            </div>
            {children}
        </section>
    );
}
