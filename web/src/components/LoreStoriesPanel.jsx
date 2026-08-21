import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { confirmAsk } from "../lib/confirm";
import { withEditorSnapshot, editorDirty, useRegisterChildEditor } from "../lib/child_editor";
import Pager, { usePager } from "./Pager.jsx";

/** Lore stories panel — the shared, global archive companions recall on
 *  demand via the recall_stories tool. Character tags are plain names on
 *  purpose (export-proof: a tag naming a companion this install doesn't
 *  have just stays in the array).
 *
 *  Two modes:
 *  - agentName given: companion-editor embed, scoped to stories tagged
 *    with that companion (add pre-tags them).
 *  - no agentName: the full History-tab view — every story, with text
 *    search, character/tag filters, and export/import of the archive.
 */
export default function LoreStoriesPanel({ agentName = null, registerEditor = null }) {
    const scoped = !!agentName;
    const [entries, setEntries] = useState([]);
    const [editing, setEditing] = useState(null); // {id?, title, description, characters (comma string), tags, story}
    const [busy, setBusy] = useState(false);
    const [openId, setOpenId] = useState(null);   // entry id with the story text expanded
    const [query, setQuery] = useState("");
    const [charFilter, setCharFilter] = useState("all");
    const [tagFilter, setTagFilter] = useState("all");
    const importInputRef = useRef(null);
    const [agentNames, setAgentNames] = useState([]);
    useEffect(() => {
        (async () => {
            try {
                setAgentNames((await rpc("/api/agents/list", {})).map((x) => x.name));
            } catch (e) { /* check degrades to no warning */ }
        })();
    }, []);

    const load = async () => {
        try {
            setEntries(await rpc("/api/lore/list", scoped ? { character: agentName } : {}));
        } catch (e) {
            notification.add(e?.message || _t("Could not load lore stories"), { type: "danger" });
        }
    };
    useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [agentName]);

    const characters = useMemo(
        () => [...new Set(entries.flatMap((e) => e.characters || []))].sort(),
        [entries]);
    const tags = useMemo(
        () => [...new Set(entries.flatMap((e) => e.tags || []))].sort(),
        [entries]);

    const visible = useMemo(() => {
        let out = entries;
        if (charFilter !== "all") out = out.filter((e) => (e.characters || []).includes(charFilter));
        if (tagFilter !== "all") out = out.filter((e) => (e.tags || []).includes(tagFilter));
        const q = query.trim().toLowerCase();
        if (q) {
            out = out.filter((e) =>
                [e.title, e.description, e.story,
                 (e.characters || []).join(" "), (e.tags || []).join(" ")]
                    .join("\n").toLowerCase().includes(q));
        }
        return out;
    }, [entries, query, charFilter, tagFilter]);

    const pager = usePager(visible.length);

    const save = async () => {
        // Soft validation: a story whose characters match no companion is
        // legal (imports may name absent companions) but unrecallable by
        // anyone — in the UI that's almost always a typo, so ask first.
        const names = (editing.characters || "").split(",").map((s) => s.trim()).filter(Boolean);
        const known = new Set(agentNames.map((n) => n.toLowerCase()));
        if (!names.some((n) => known.has(n.toLowerCase()))) {
            const msg = names.length
                ? _t("None of the characters (%s) match an existing companion, so no companion will be able to recall this story. Save anyway?", names.join(", "))
                : _t("No characters are tagged, so no companion will be able to recall this story. Save anyway?");
            if (!(await confirmAsk(msg))) return;
        }
        setBusy(true);
        try {
            await rpc("/api/lore/save", {
                id: editing.id,
                title: editing.title,
                description: editing.description,
                characters: editing.characters,
                tags: editing.tags,
                story: editing.story,
            });
            setEditing(null);
            load();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Could not save the story"), { type: "danger" });
            return false;
        } finally {
            setBusy(false);
        }
    };

    // The companion form's Save commits an open story draft too.
    useRegisterChildEditor(registerEditor, editorDirty(editing), async () => {
        if (!editing || !editorDirty(editing)) return true;
        if (!editing.title.trim() || !editing.story.trim()) {
            notification.add(
                _t("The open story draft is incomplete — finish it or cancel it, then save again."),
                { type: "warning" });
            return false;
        }
        return save();
    });

    const remove = async (entry) => {
        if (!(await confirmAsk(_t("Delete the story '%s'? It disappears from every companion tagged in it.", entry.title)))) return;
        try {
            await rpc("/api/lore/delete", { id: entry.id });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const exportStories = async () => {
        try {
            const payload = charFilter !== "all" ? { character: charFilter } : {};
            const data = await rpc("/api/lore/export", payload);
            const url = URL.createObjectURL(
                new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
            );
            const a = document.createElement("a");
            a.href = url;
            const suffix = charFilter !== "all"
                ? "-" + charFilter.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")
                : "";
            a.download = `rexclaw-lore${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            notification.add(e?.message || _t("Export failed"), { type: "danger" });
        }
    };

    const importStories = async (file) => {
        try {
            let data;
            try {
                data = JSON.parse(await file.text());
            } catch {
                throw new Error(_t("Not a valid JSON file."));
            }
            const res = await rpc("/api/lore/import", data);
            notification.add(
                _t("Imported %s stories (%s duplicates skipped).", res.imported, res.duplicates),
                { type: "success" }
            );
            load();
        } catch (e) {
            notification.add(e?.message || _t("Import failed"), { type: "danger" });
        }
    };

    const set = (key, value) => setEditing((c) => ({ ...c, [key]: value }));

    // The edit form: rendered at the top for a NEW story, and IN PLACE of
    // the row being edited for an existing one — a form jumping to the top
    // of a long list is disorienting.
    const editorForm = editing && (
        <div className="rx_agent_editor" style={{ marginTop: "0.5rem" }}>
            <div className="rx_row">
                <div>
                    <label>{_t("Story title")}</label>
                    <input type="text" value={editing.title}
                           onChange={(ev) => set("title", ev.target.value)} />
                </div>
                <div>
                    <label title={_t("Every character present in the story, comma-separated. Plain names: tagging a companion that doesn't exist on an install is fine, the name just stays in the list.")}>
                        {_t("Characters (comma-separated names)")}
                    </label>
                    <input type="text" value={editing.characters}
                           placeholder={_t("e.g. 'Eve, Ara'")}
                           onChange={(ev) => set("characters", ev.target.value)} />
                </div>
                <div>
                    <label title={_t("Optional lowercase tags, comma-separated: life periods (childhood, teens, university, twenties, career, pre-crew, lost-years, crew-era, ongoing) plus free topic tags. The companion can filter and search its story list by these, and the full tag set is listed in its tool description.")}>
                        {_t("Tags (optional, comma-separated)")}
                    </label>
                    <input type="text" value={editing.tags}
                           placeholder={_t("e.g. 'childhood, sad'")}
                           onChange={(ev) => set("tags", ev.target.value)} />
                </div>
            </div>
            <label title={_t("One line the companion sees when listing stories: who is involved, the main plot points, roughly when it happened. Without it, only the title tells the companion what a story is about.")}>
                {_t("Description (who, what, when - shown in the story list)")}
            </label>
            <input type="text" value={editing.description}
                   onChange={(ev) => set("description", ev.target.value)} />
            <label>{_t("Story")}</label>
            <textarea rows={8} value={editing.story}
                      onChange={(ev) => set("story", ev.target.value)} />
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button className="btn btn-sm" disabled={busy || !editing.title.trim() || !editing.story.trim()} onClick={save}>
                    {_t("Save story")}
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>
                    {_t("Cancel")}
                </button>
            </div>
        </div>
    );

    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3 style={{ margin: 0 }}><i className="fa fa-book" /> {_t("Lore stories")}</h3>
                <span style={{ display: "flex", gap: "0.5rem" }}>
                    {!scoped && (
                        <>
                            <button className="btn btn-sm" onClick={exportStories}
                                    title={_t("Download the stories as a JSON file (respects the character filter)")}>
                                <i className="fa fa-download" /> {_t("Export")}
                            </button>
                            <button className="btn btn-sm" onClick={() => importInputRef.current?.click()}
                                    title={_t("Import a lore JSON file — stories are matched by title, existing ones are kept")}>
                                <i className="fa fa-upload" /> {_t("Import")}
                            </button>
                            <input ref={importInputRef} type="file" accept=".json,application/json"
                                   style={{ display: "none" }}
                                   onChange={(ev) => {
                                       const f = ev.target.files?.[0];
                                       ev.target.value = "";
                                       if (f) importStories(f);
                                   }} />
                        </>
                    )}
                    <button className="btn btn-sm" onClick={() => setEditing(withEditorSnapshot({ title: "", description: "", characters: agentName || "", tags: "", story: "" }))}>
                        <i className="fa fa-plus" /> {_t("Add story")}
                    </button>
                </span>
            </div>
            <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                {scoped
                    ? _t("Written stories from this companion's past, recalled on demand via the recall_stories tool. Tag every character present in the story; stories are shared, so a story tagged with several companions appears for each of them.")
                    : _t("The full shared archive, across all companions. Each companion can recall the stories tagged with their name via the recall_stories tool.")}
            </p>
            {!scoped && (
                <div className="rx_row" style={{ marginBottom: "0.5rem" }}>
                    <div>
                        <input type="text" value={query} placeholder={_t("Search title, text, characters, tags…")}
                               onChange={(ev) => setQuery(ev.target.value)} />
                    </div>
                    <div>
                        <select value={charFilter} onChange={(ev) => setCharFilter(ev.target.value)}>
                            <option value="all">{_t("All characters")}</option>
                            {characters.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                    </div>
                    <div>
                        <select value={tagFilter} onChange={(ev) => setTagFilter(ev.target.value)}>
                            <option value="all">{_t("All tags")}</option>
                            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                    </div>
                </div>
            )}
            {!scoped && (query || charFilter !== "all" || tagFilter !== "all") && (
                <p className="text-muted small" style={{ margin: "0 0 0.25rem" }}>
                    {_t("%s of %s stories", visible.length, entries.length)}
                </p>
            )}
            {editing && editing.id == null && editorForm}
            {!entries.length && !editing && (
                <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                    {_t("No stories yet.")}
                </p>
            )}
            <Pager pager={pager} />
            {pager.slice(visible).map((entry) => (editing && editing.id === entry.id) ? (
                <React.Fragment key={entry.id}>{editorForm}</React.Fragment>
            ) : (
                <div key={entry.id} className="rx_memory_row">
                    <strong>{entry.title}</strong>
                    <span className="rx_memory_content text-muted small">
                        {entry.description || (entry.characters || []).join(", ")}
                    </span>
                    <span className="rx_memory_meta">
                        {(entry.characters || []).join(", ")}
                        {(entry.tags || []).length ? ` · ${entry.tags.join(", ")}` : ""}
                    </span>
                    <button className="btn btn-sm btn-link p-0"
                            onClick={() => setOpenId(openId === entry.id ? null : entry.id)}>
                        {openId === entry.id ? _t("Hide") : _t("Read")}
                    </button>
                    <button className="btn btn-sm btn-link p-0"
                            onClick={() => setEditing(withEditorSnapshot({
                                id: entry.id,
                                title: entry.title,
                                description: entry.description || "",
                                characters: (entry.characters || []).join(", "),
                                tags: (entry.tags || []).join(", "),
                                story: entry.story,
                            }))}>
                        {_t("Edit")}
                    </button>
                    <button className="btn btn-sm btn-link p-0" title={_t("Remove")} onClick={() => remove(entry)}>
                        <i className="fa fa-trash-o" />
                    </button>
                    {openId === entry.id && (
                        <p className="small" style={{ flexBasis: "100%", whiteSpace: "pre-wrap", margin: "0.25rem 0 0" }}>
                            {entry.story}
                        </p>
                    )}
                </div>
            ))}
        </div>
    );
}

