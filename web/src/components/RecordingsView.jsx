import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { formatClock } from "../lib/format_clock";
import { fmtLocal } from "./HeartbeatsPanel.jsx";
import SoundLibrary from "./SoundLibrary.jsx";

/** History → Recordings: the audio studio playground.
 *
 *  Left: the script library, with built-in examples by category (read-only,
 *  shipped in server/audio_examples.py) and the user's own saved scripts.
 *  Right: the editor (voice, language, base pace, the script itself) and
 *  Generate, which renders through the same audio_studio pipeline as the
 *  companions' create_voicemail tool. Below: every recording, playground
 *  renders and companion voicemails alike. */

const TTS_USD_PER_CHAR = 15 / 1_000_000;   // docs.x.ai pricing: $15 / 1M characters
const DEFAULT_CATEGORY = "My scripts";
const NEW_CATEGORY = "__new__";
const STUDIO = "__studio__";
const EMPTY = { kind: "new", id: null, name: "", category: DEFAULT_CATEGORY, voice: "",
    language: "en", pace: 1.0, script: "" };

/** Characters that will actually be spoken (directive lines and L:/R: prefixes excluded). */
function speechChars(script) {
    return (script || "").split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^\{.*\}$/.test(l))
        .map((l) => l.replace(/^[LR]\s*:\s*/i, ""))
        .join(" ").length;
}

/** The full script guide, rendered from server/audio_studio.guide(): the
 *  same data the companions' create_voicemail description is built from,
 *  so the two can never disagree. */
function StudioGuide({ guide, onTryExample, rules }) {
    const tagRows = (groups) => groups.map(([group, tags]) => (
        <React.Fragment key={group}>
            <tr className="rx_studio_guide_group"><td colSpan={2}>{group}</td></tr>
            {tags.map(([tag, what]) => (
                <tr key={tag}><td><code>{tag}</code></td><td>{what}</td></tr>
            ))}
        </React.Fragment>
    ));
    return (
        <details className="rx_studio_help">
            <summary><i className="fa fa-book" /> {_t("Full guide: how scripts work, every speech tag and directive")}</summary>
            <div className="rx_studio_guide">
                <h4>{_t("How a script works")}</h4>
                <ul>{guide.how_it_works.map((p, i) => <li key={i}>{p}</li>)}</ul>

                <h4>{_t("Speech tags")}</h4>
                <p className="text-muted">{_t("Used inside spoken lines. This is xAI's complete list.")}</p>
                <div className="rx_studio_guide_cols">
                    <table className="rx_studio_guide_table">
                        <thead><tr><th colSpan={2}>{_t("Inline: placed where the sound happens")}</th></tr></thead>
                        <tbody>{tagRows(guide.tags.inline)}</tbody>
                    </table>
                    <table className="rx_studio_guide_table">
                        <thead><tr><th colSpan={2}>{_t("Wrapping: around whole phrases")}</th></tr></thead>
                        <tbody>{tagRows(guide.tags.wrapping)}</tbody>
                    </table>
                </div>
                <ul>{guide.tags.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>

                <h4>{_t("Directives")}</h4>
                <ul>{guide.directive_rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
                <table className="rx_studio_guide_table">
                    <thead><tr><th colSpan={2}>{_t("Values (UPPERCASE words in a directive are values you fill in)")}</th></tr></thead>
                    <tbody>
                        {guide.value_types.map(([name, definition]) => (
                            <tr key={name}><td><code>{name}</code></td><td>{definition}</td></tr>
                        ))}
                    </tbody>
                </table>
                {guide.directives.map(([section, entries]) => (
                    <React.Fragment key={section}>
                        <h5 className="rx_studio_guide_section">{section}</h5>
                        {entries.map((d) => (
                            <div key={d.syntax} className="rx_studio_directive">
                                <div className="rx_studio_directive_head">
                                    <code>{d.syntax}</code>
                                </div>
                                <p>{d.what}</p>
                                {d.params.length > 0 && (
                                    <table className="rx_studio_guide_table">
                                        <tbody>
                                            {d.params.map(([name, need, spec]) => (
                                                <tr key={name}>
                                                    <td><code>{name}</code></td>
                                                    <td className={"rx_studio_need rx_studio_need--" + need}>{_t(need)}</td>
                                                    <td>{spec}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                                <pre className="rx_studio_guide_example">{d.example}</pre>
                            </div>
                        ))}
                    </React.Fragment>
                ))}

                <h4>{_t("Your sounds")}</h4>
                {guide.sounds.length ? (
                    <table className="rx_studio_guide_table">
                        <tbody>
                            {guide.sounds.map((s) => (
                                <tr key={s.name}>
                                    <td><code>{s.use}</code>{s.length && <span className="text-muted"> ({s.length})</span>}</td>
                                    <td>{s.description || _t("(no description)")}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <p className="text-muted">{_t("None uploaded yet. Add some under Your sounds below; they appear here and in the companions' guide.")}</p>
                )}

                <h4>
                    {_t("Writing rules")}{" "}
                    <span className="rx_studio_badge">{guide.rules_custom ? _t("Custom") : _t("Default")}</span>
                </h4>
                <p className="text-muted">
                    {_t("Companions follow these rules whenever they write a recording. Override them with your own style of rules; Reset to default brings back the built-in ones.")}
                </p>
                {rules.draft === null ? (
                    <>
                        <pre className="rx_studio_guide_example">{guide.rules_custom || guide.rules_default}</pre>
                        <span style={{ display: "flex", gap: "0.5rem" }}>
                            <button className="btn btn-sm" onClick={rules.onEdit}>
                                <i className="fa fa-pencil" /> {guide.rules_custom ? _t("Edit") : _t("Override")}
                            </button>
                            {guide.rules_custom && (
                                <button className="btn btn-sm" onClick={rules.onReset}>
                                    <i className="fa fa-undo" /> {_t("Reset to default")}
                                </button>
                            )}
                        </span>
                    </>
                ) : (
                    <>
                        <textarea className="rx_studio_script" rows={12} spellCheck={false}
                                  value={rules.draft} onChange={(ev) => rules.setDraft(ev.target.value)} />
                        <span style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                            <button className="btn btn-sm btn-primary" onClick={rules.onSave}>
                                <i className="fa fa-save" /> {_t("Save rules")}
                            </button>
                            <button className="btn btn-sm" onClick={() => rules.setDraft(null)}>
                                {_t("Cancel")}
                            </button>
                        </span>
                    </>
                )}

                <h4>{_t("Examples")}</h4>
                <p className="text-muted">{_t("A voice note: short pieces need no directives.")}</p>
                <pre className="rx_studio_guide_example">{guide.example_note}</pre>
                <p className="text-muted">
                    {_t("A six-minute hypnosis-style session: arrival with music over a bed, breathing, a chime-marked crossfade into the trance bed, countdown with reverb and layered voices, a dual-induction deepener, suggestions with underlay, a close sweeping whisper and one echoed key phrase, crossfade to wake-up music, count-up.")}
                </p>
                <pre className="rx_studio_guide_example">{guide.example}</pre>
                <button className="btn btn-sm" onClick={onTryExample}>
                    <i className="fa fa-pencil" /> {_t("Open this example in the editor")}
                </button>
            </div>
        </details>
    );
}

export default function RecordingsView({ active }) {
    const [data, setData] = useState(null);      // bootstrap payload
    const [companions, setCompanions] = useState([]);
    const [draft, setDraft] = useState(EMPTY);
    const [saved, setSaved] = useState(EMPTY);   // snapshot for the dirty check
    const [busy, setBusy] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [last, setLast] = useState(null);      // last render result
    const [openCats, setOpenCats] = useState({});
    const [newCategory, setNewCategory] = useState(null);   // text while "New category…" is picked
    const [rulesDraft, setRulesDraft] = useState(null);     // text while the writing rules are being edited
    const [recFilter, setRecFilter] = useState("all");      // recordings list: category shown
    const [recCompanion, setRecCompanion] = useState("all"); // …and whose (STUDIO = playground renders)
    const loaded = useRef(false);

    const load = async () => {
        try {
            const [boot, agents] = await Promise.all([
                rpc("/api/audio/bootstrap", {}),
                rpc("/api/agents/list", {}),
            ]);
            setData(boot);
            setCompanions(agents);
            if (!loaded.current) {
                loaded.current = true;
                const first = boot.examples[0];
                if (first) openExample(first);
            }
        } catch (e) {
            notification.add(e?.message || _t("Could not load the recordings"), { type: "danger" });
        }
    };
    useEffect(() => { if (active) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [active]);

    // Tick a counter while a render runs; long pieces take a minute or more.
    useEffect(() => {
        if (!busy) return undefined;
        setElapsed(0);
        const t = setInterval(() => setElapsed((s) => s + 1), 1000);
        return () => clearInterval(t);
    }, [busy]);

    const category = newCategory !== null ? newCategory.trim() : draft.category;
    const dirty = draft.script !== saved.script || draft.name !== saved.name
        || draft.voice !== saved.voice || draft.language !== saved.language
        || category !== saved.category;
    // Examples are read-only, so only edits to one of the user's own
    // scripts (or a new one with content) count as unsaved work.
    const scriptDirty = dirty && (draft.kind === "mine" || (draft.kind === "new" && !!draft.script.trim()));
    const activeRules = data ? (data.guide.rules_custom || data.guide.rules_default) : "";
    const rulesDirty = rulesDraft !== null && rulesDraft.trim() !== activeRules.trim();
    const guardDirty = scriptDirty || rulesDirty;

    const openScript = (next) => { setDraft(next); setSaved(next); setNewCategory(null); setLast(null); };
    // An example saved as the user's own lands in "My scripts" unless they
    // pick another category.
    const openExample = (ex) => openScript({
        kind: "example", id: ex.id, name: ex.name, category: DEFAULT_CATEGORY,
        voice: ex.voice || "eve", language: "en", pace: 1.0, script: ex.script,
    });
    const openMine = (s) => openScript({
        kind: "mine", id: s.id, name: s.name, category: s.category || DEFAULT_CATEGORY,
        voice: s.voice, language: s.language, pace: 1.0, script: s.script,
    });

    const guardedOpen = async (open) => {
        if (scriptDirty && !(await confirmAsk(_t("Discard the unsaved changes to this script?")))) return;
        open();
    };

    // Writing rules: saving the defaults unchanged, or an empty box, stores
    // no override, so the built-in rules keep improving with app updates.
    const saveRules = async (text) => {
        const value = (text ?? "").trim() === data.guide.rules_default.trim() ? "" : text;
        try {
            const res = await rpc("/api/audio/rules/save", { rules: value });
            setData((d) => ({ ...d, guide: res.guide }));
            setRulesDraft(null);
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Could not save the rules"), { type: "danger" });
            return false;
        }
    };
    const resetRules = async () => {
        if (!(await confirmAsk(_t("Replace your writing rules with the defaults?")))) return;
        saveRules("");
    };

    const save = async () => {
        if (!draft.name.trim()) {
            notification.add(_t("Give the script a name first."), { type: "warning" });
            return false;
        }
        if (!category) {
            notification.add(_t("Name the new category first."), { type: "warning" });
            return false;
        }
        try {
            const res = await rpc("/api/audio/scripts/save", {
                id: draft.kind === "mine" ? draft.id : null,
                name: draft.name, category, voice: draft.voice || "eve",
                language: draft.language, script: draft.script,
            });
            setData((d) => ({ ...d, scripts: res.scripts }));
            const next = { ...draft, kind: "mine", id: res.id, category };
            setDraft(next);
            setSaved(next);
            setNewCategory(null);
            setOpenCats((o) => ({ ...o, [category]: true }));
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Could not save the script"), { type: "danger" });
            return false;
        }
    };
    useUnsavedGuard(active, guardDirty,
        async () => (!rulesDirty || await saveRules(rulesDraft)) && (!scriptDirty || await save()),
        () => { setDraft(saved); setNewCategory(null); setRulesDraft(null); });

    const removeScript = async () => {
        if (!(await confirmAsk(_t("Delete the script '%s'? Recordings made from it are kept.", draft.name)))) return;
        try {
            const res = await rpc("/api/audio/scripts/delete", { id: draft.id });
            setData((d) => ({ ...d, scripts: res.scripts }));
            openScript(EMPTY);
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    const generate = async () => {
        setBusy(true);
        setLast(null);
        try {
            // An example renders under its own section; anything else under
            // the category picked for it.
            const example = draft.kind === "example" && data.examples.find((e) => e.id === draft.id);
            const res = await rpc("/api/audio/render", {
                name: draft.name || _t("Untitled recording"),
                category: example ? example.category : (category || DEFAULT_CATEGORY),
                script: draft.script, voice: draft.voice || "eve",
                language: draft.language, pace: Number(draft.pace) || 1,
            });
            setLast(res);
            setData((d) => ({ ...d, recordings: res.recordings }));
        } catch (e) {
            notification.add(e?.message || _t("Rendering failed"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    const removeRecording = async (rec) => {
        if (!(await confirmAsk(_t("Delete the recording '%s'? The audio file is removed too.", rec.name)))) return;
        try {
            const res = await rpc("/api/audio/recordings/delete", { id: rec.id });
            setData((d) => ({ ...d, recordings: res.recordings }));
            if (last?.recording_id === rec.id) setLast(null);
        } catch (e) {
            notification.add(e?.message || _t("Delete failed"), { type: "danger" });
        }
    };

    // Library groups: "My scripts", then the user's own categories, then the
    // built-in ones. The user's scripts sit above the examples in a shared
    // category.
    const { groups, categories } = useMemo(() => {
        const builtIn = data?.categories || [DEFAULT_CATEGORY];
        const own = [...new Set((data?.scripts || []).map((s) => s.category || DEFAULT_CATEGORY))]
            .filter((c) => !builtIn.includes(c))
            .sort((a, b) => a.localeCompare(b));
        const order = [builtIn[0], ...own, ...builtIn.slice(1)];
        const byName = Object.fromEntries(order.map((c) => [c, { name: c, mine: [], examples: [] }]));
        for (const s of data?.scripts || []) byName[s.category || DEFAULT_CATEGORY].mine.push(s);
        for (const ex of data?.examples || []) byName[ex.category]?.examples.push(ex);
        return { groups: order.map((c) => byName[c]), categories: order };
    }, [data]);

    // Recordings filter: the categories recordings actually carry, in
    // library order (companion voicemails and anything unlisted last), with
    // counts.
    const recCategories = useMemo(() => {
        const counts = {};
        for (const r of data?.recordings || []) counts[r.category] = (counts[r.category] || 0) + 1;
        const rank = (c) => { const i = categories.indexOf(c); return i < 0 ? categories.length : i; };
        return Object.entries(counts).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
    }, [data, categories]);
    // Companion filter: whoever sent each voicemail, plus one entry for the
    // playground's own renders, which belong to no companion.
    const recCompanions = useMemo(() => {
        const counts = {};
        for (const r of data?.recordings || []) {
            const key = r.source === "voicemail" ? (r.agent_name || _t("a companion")) : STUDIO;
            counts[key] = (counts[key] || 0) + 1;
        }
        return Object.entries(counts).sort(([a], [b]) =>
            (a === STUDIO) - (b === STUDIO) || a.localeCompare(b));
    }, [data]);
    const recCompanionOf = (r) => (r.source === "voicemail" ? (r.agent_name || _t("a companion")) : STUDIO);
    // A filter whose last recording was deleted falls back to all.
    useEffect(() => {
        if (recFilter !== "all" && !recCategories.some(([c]) => c === recFilter)) setRecFilter("all");
        if (recCompanion !== "all" && !recCompanions.some(([c]) => c === recCompanion)) setRecCompanion("all");
    }, [recCategories, recFilter, recCompanions, recCompanion]);

    const activeGroup = draft.kind === "example"
        ? data?.examples.find((e) => e.id === draft.id)?.category
        : draft.kind === "mine" ? (saved.category || DEFAULT_CATEGORY) : null;
    const voices = data?.voices || [];
    const builtIn = voices.filter((v) => !v.custom);
    const custom = voices.filter((v) => v.custom);
    const knownVoice = !draft.voice || voices.some((v) => v.voice_id === draft.voice)
        || companions.some((c) => c.voice === draft.voice);
    const chars = speechChars(draft.script);
    const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

    if (!data) {
        return <div className="rx_settings"><div className="rx_settings_inner rx_settings_inner--wide">
            <section><p className="text-muted small">{_t("Loading…")}</p></section>
        </div></div>;
    }

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3><i className="fa fa-headphones" /> {_t("Recording studio")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.75rem" }}>
                        {_t("Write or pick a script and render it with any xAI voice: voice notes, meditations, breathing exercises, sleep stories and hypnosis-style sessions. Directive lines in braces add timed silence, breathing, ambient sound and effects. Companions write the same kind of script when they send you a voice message in chat.")}
                    </p>
                    <div className="rx_studio">
                        <aside className="rx_studio_library">
                            <button className="btn btn-sm" style={{ width: "100%", marginBottom: "0.5rem" }}
                                    onClick={() => guardedOpen(() => openScript({ ...EMPTY, voice: draft.voice }))}>
                                <i className="fa fa-plus" /> {_t("New script")}
                            </button>
                            {groups.map((g, i) => {
                                const empty = !g.mine.length && !g.examples.length;
                                if (empty && i > 0) return null;
                                // Collapsed by default, except the section holding the open script.
                                const open = openCats[g.name] ?? (g.name === activeGroup);
                                return (
                                    <React.Fragment key={g.name}>
                                        <button className="rx_studio_group rx_studio_group--toggle"
                                                onClick={() => setOpenCats((o) => ({ ...o, [g.name]: !open }))}>
                                            <i className={"fa " + (open ? "fa-caret-down" : "fa-caret-right")} /> {_t(g.name)}
                                        </button>
                                        {open && empty && (
                                            <p className="text-muted small" style={{ margin: "0.2rem 0.4rem 0.5rem" }}>
                                                {_t("None yet. Open an example and choose 'Save as my script' to make it yours.")}
                                            </p>
                                        )}
                                        {open && g.mine.map((s) => (
                                            <button key={`m${s.id}`} title={_t("Your script")}
                                                    className={"rx_studio_item" + (draft.kind === "mine" && draft.id === s.id ? " is-active" : "")}
                                                    onClick={() => guardedOpen(() => openMine(s))}>
                                                <i className="fa fa-file-text-o" /> {s.name}
                                            </button>
                                        ))}
                                        {open && g.examples.map((ex) => (
                                            <button key={ex.id} title={ex.description}
                                                    className={"rx_studio_item" + (draft.kind === "example" && draft.id === ex.id ? " is-active" : "")}
                                                    onClick={() => guardedOpen(() => openExample(ex))}>
                                                {ex.name}
                                            </button>
                                        ))}
                                    </React.Fragment>
                                );
                            })}
                        </aside>
                        <div className="rx_studio_editor">
                            {draft.kind === "example" && (
                                <p className="text-muted small" style={{ margin: "0 0 0.4rem" }}>
                                    <i className="fa fa-info-circle" />{" "}
                                    {data.examples.find((e) => e.id === draft.id)?.description}{" "}
                                    {_t("Built-in example: edit freely, then save it as your own script to keep the changes.")}
                                </p>
                            )}
                            <div className="rx_row">
                                <div style={{ flex: 2 }}>
                                    <label>{_t("Name")}</label>
                                    <input type="text" value={draft.name} placeholder={_t("e.g. 'Sunday wind-down'")}
                                           onChange={(ev) => set("name", ev.target.value)} />
                                </div>
                                <div style={{ flex: 2 }}>
                                    <label title={_t("Where the script is filed in the library when you save it: one of the built-in sections, one of your own, or a new one.")}>
                                        {_t("Category")}
                                    </label>
                                    {newCategory === null ? (
                                        <select value={draft.category}
                                                onChange={(ev) => (ev.target.value === NEW_CATEGORY
                                                    ? setNewCategory("")
                                                    : set("category", ev.target.value))}>
                                            {categories.map((c) => <option key={c} value={c}>{_t(c)}</option>)}
                                            <option value={NEW_CATEGORY}>{_t("New category…")}</option>
                                        </select>
                                    ) : (
                                        <span style={{ display: "flex", gap: "0.35rem" }}>
                                            <input type="text" autoFocus value={newCategory}
                                                   placeholder={_t("New category name")}
                                                   onChange={(ev) => setNewCategory(ev.target.value)} />
                                            <button className="btn btn-sm" title={_t("Back to the list")}
                                                    onClick={() => setNewCategory(null)}>
                                                <i className="fa fa-times" />
                                            </button>
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="rx_row">
                                <div style={{ flex: 2 }}>
                                    <label title={_t("The speaker for the script. {voice …} lines inside the script can switch voices part-way, and {dual …} picks the second voice.")}>
                                        {_t("Voice")}
                                    </label>
                                    <select value={draft.voice} onChange={(ev) => set("voice", ev.target.value)}>
                                        {!knownVoice && <option value={draft.voice}>{draft.voice}</option>}
                                        {companions.length > 0 && (
                                            <optgroup label={_t("Companions")}>
                                                {companions.map((c) => (
                                                    <option key={`c${c.id}`} value={c.voice}>{c.name} ({c.voice})</option>
                                                ))}
                                            </optgroup>
                                        )}
                                        <optgroup label={_t("xAI voices")}>
                                            {builtIn.map((v) => (
                                                <option key={v.voice_id} value={v.voice_id}>
                                                    {v.name}{v.gender ? ` · ${_t(v.gender)}` : ""}
                                                </option>
                                            ))}
                                        </optgroup>
                                        {custom.length > 0 && (
                                            <optgroup label={_t("Your custom voices")}>
                                                {custom.map((v) => (
                                                    <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                                                ))}
                                            </optgroup>
                                        )}
                                    </select>
                                </div>
                                <div>
                                    <label title={_t("Pick a fully supported language from the list, or type any other language code (e.g. nl for Dutch): other languages work too, with varying accuracy.")}>
                                        {_t("Language")}
                                    </label>
                                    <input type="text" list="rx-tts-languages" value={draft.language}
                                           onChange={(ev) => set("language", ev.target.value.trim())} />
                                    <datalist id="rx-tts-languages">
                                        {data.languages.map(([code, name]) => (
                                            <option key={code} value={code}>{_t(name)}</option>
                                        ))}
                                    </datalist>
                                </div>
                                <div>
                                    <label title={_t("Starting speech speed (0.7–1.5). {pace …} lines in the script override it from that point on.")}>
                                        {_t("Base pace")}
                                    </label>
                                    <input type="number" min="0.7" max="1.5" step="0.05" value={draft.pace}
                                           onChange={(ev) => set("pace", ev.target.value)}
                                           onBlur={() => {
                                               // Clamp on leave, not per keystroke: "0.8" passes through "0".
                                               const n = Number(draft.pace);
                                               set("pace", Number.isFinite(n) && n > 0 ? Math.min(1.5, Math.max(0.7, n)) : 1);
                                           }} />
                                </div>
                            </div>
                            <label>{_t("Script")}</label>
                            <textarea className="rx_studio_script" rows={22} spellCheck={false}
                                      value={draft.script} onChange={(ev) => set("script", ev.target.value)} />
                            <StudioGuide guide={data.guide}
                                         onTryExample={() => guardedOpen(() => openScript({
                                             ...EMPTY, name: _t("Guide example"),
                                             voice: draft.voice || "eve", script: data.guide.example,
                                         }))}
                                         rules={{
                                             draft: rulesDraft, setDraft: setRulesDraft,
                                             onEdit: () => setRulesDraft(activeRules),
                                             onSave: () => saveRules(rulesDraft),
                                             onReset: resetRules,
                                         }} />
                            <div className="rx_studio_actions">
                                <button className="btn btn-sm btn-primary" disabled={busy || !draft.script.trim()} onClick={generate}>
                                    {busy
                                        ? <><i className="fa fa-spinner fa-spin" /> {_t("Rendering… %ss", elapsed)}</>
                                        : <><i className="fa fa-play-circle" /> {_t("Generate")}</>}
                                </button>
                                <button className="btn btn-sm" disabled={busy || !draft.script.trim()} onClick={save}
                                        title={draft.kind === "mine" ? "" : _t("Keep this script in 'My scripts' to edit and reuse it")}>
                                    <i className="fa fa-save" /> {draft.kind === "mine" ? _t("Save") : _t("Save as my script")}
                                </button>
                                {draft.kind === "mine" && (
                                    <button className="btn btn-sm" disabled={busy} onClick={removeScript}>
                                        <i className="fa fa-trash-o" /> {_t("Delete")}
                                    </button>
                                )}
                                <span className="text-muted small" style={{ marginLeft: "auto" }}
                                      title={_t("xAI bills text-to-speech at $15 per million characters. Layered and dual lines are spoken more than once, so they cost a little more.")}>
                                    {_t("%s speech characters · about $%s", chars.toLocaleString(), (chars * TTS_USD_PER_CHAR).toFixed(3))}
                                </span>
                            </div>
                            {busy && (
                                <p className="text-muted small" style={{ margin: "0.4rem 0 0" }}>
                                    {_t("Long pieces take a minute or more: the speech is voiced in parallel, then mixed.")}
                                </p>
                            )}
                            {last && (
                                <div className="rx_studio_result">
                                    <audio src={last.audio_url} controls autoPlay />
                                    <span className="text-muted small">
                                        {formatClock(last.duration_seconds)} · ${last.usd.toFixed(3)}
                                    </span>
                                    {last.warnings?.length > 0 && (
                                        <ul className="rx_studio_warnings">
                                            {last.warnings.map((w, i) => <li key={i}>{w}</li>)}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </section>
                <SoundLibrary sounds={data.sounds} kinds={data.sound_kinds}
                              onChange={(p) => setData((d) => ({ ...d, sounds: p.sounds, guide: p.guide }))} />
                <section>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.4rem" }}>
                        <h3 style={{ margin: 0 }}><i className="fa fa-list" /> {_t("Recordings")}</h3>
                        {data.recordings.length > 0 && (
                            <span style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
                                <select value={recCompanion} style={{ width: "auto" }}
                                        onChange={(ev) => setRecCompanion(ev.target.value)}>
                                    <option value="all">{_t("All companions (%s)", data.recordings.length)}</option>
                                    {recCompanions.map(([c, n]) => (
                                        <option key={c} value={c}>{c === STUDIO ? _t("Studio recordings") : c} ({n})</option>
                                    ))}
                                </select>
                                <select value={recFilter} style={{ width: "auto" }}
                                        onChange={(ev) => setRecFilter(ev.target.value)}>
                                    <option value="all">{_t("All categories (%s)", data.recordings.length)}</option>
                                    {recCategories.map(([c, n]) => (
                                        <option key={c} value={c}>{_t(c)} ({n})</option>
                                    ))}
                                </select>
                            </span>
                        )}
                    </div>
                    {!data.recordings.length && (
                        <p className="text-muted small">{_t("Nothing recorded yet. Generate one above, or ask a companion for a voice message in chat.")}</p>
                    )}
                    {data.recordings.filter((rec) => (recFilter === "all" || rec.category === recFilter)
                        && (recCompanion === "all" || recCompanionOf(rec) === recCompanion)).map((rec) => (
                        <div key={rec.id} className="rx_studio_rec">
                            <div className="rx_studio_rec_head">
                                <strong>{rec.name}</strong>
                                <span className="rx_studio_badge">
                                    {rec.source === "voicemail"
                                        ? _t("from %s", rec.agent_name || _t("a companion"))
                                        : _t(rec.category)}
                                </span>
                                <span className="text-muted small">
                                    {rec.voice} · {formatClock(rec.duration_seconds)} · {fmtLocal(rec.created_at)}
                                </span>
                                <span style={{ marginLeft: "auto", display: "flex", gap: "0.6rem" }}>
                                    <button className="btn btn-sm btn-link p-0" title={_t("Open the script in the editor")}
                                            onClick={() => guardedOpen(() => openScript({
                                                ...EMPTY, name: rec.name, voice: rec.voice || "eve", script: rec.script,
                                            }))}>
                                        <i className="fa fa-pencil" /> {_t("Script")}
                                    </button>
                                    <a className="btn btn-sm btn-link p-0" href={rec.audio_path}
                                       download={`${rec.name}.mp3`} title={_t("Download the mp3")}>
                                        <i className="fa fa-download" />
                                    </a>
                                    {/* Files an extension wrote beside the recording, named
                                        like the mp3 download so players pair them up. */}
                                    {(rec.extra_files || []).map((url) => {
                                        const suffix = url.split("/").pop().split(".").slice(1).join(".");
                                        return (
                                            <a key={url} className="btn btn-sm btn-link p-0" href={url}
                                               download={`${rec.name}.${suffix}`} title={_t("Download %s", `.${suffix}`)}>
                                                <i className="fa fa-file-code-o" /> .{suffix}
                                            </a>
                                        );
                                    })}
                                    <button className="btn btn-sm btn-link p-0" title={_t("Delete")}
                                            onClick={() => removeRecording(rec)}>
                                        <i className="fa fa-trash-o" />
                                    </button>
                                </span>
                            </div>
                            <audio src={rec.audio_path} controls preload="none" />
                        </div>
                    ))}
                </section>
            </div>
        </div>
    );
}
