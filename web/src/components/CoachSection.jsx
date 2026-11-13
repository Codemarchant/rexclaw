import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { withEditorSnapshot, editorDirty, useRegisterChildEditor } from "../lib/child_editor";

// The question the example rules put to the decision model once their wait
// is over: is this a moment something new could come in?
const GOOD_MOMENT = "Is `conversation` at a point where something new could come in naturally: no physical scene under way, and no in-depth talk or activity in the middle?";

// Conversation coach (voice calls): the tracked moments and rules a
// companion gets when the coach is first switched on with empty lists (or
// from "Add the examples"). A rule here is one particular thing for the
// companion to get round to: a long wait since they last did it, and then a
// check that the moment allows it. All start switched off: they are
// examples to read, adapt and turn on. Model-facing text - deliberately not
// translated. Key order matches server/coach.py's cleaned JSON, so an
// untouched list never reads as an unsaved edit.
const EXAMPLE_COACH_MOMENTS = [
    {
        id: "joke",
        name: "Joke",
        question: "Did the companion make a joke in `last_reply`?",
        active: false,
    },
    {
        id: "vedalroast",
        name: "Vedal roast",
        question: "Did the companion make fun of Vedal's bald turtle head in `last_reply`?",
        active: false,
    },
];
const EXAMPLE_COACH_RULES = [
    {
        id: "joke",
        name: "Time for a joke",
        judge: "decision",
        question: GOOD_MOMENT,
        when: "yes",
        stat: "stat:joke",
        stat_min: 30,
        stat_max: 45,
        advice: "It has been a while since they made a joke. Find the material in this conversation: something said earlier that the present moment echoes, an absurd side of what is being talked about. Say what the material is and why it is funny, and leave the line itself to them. If nothing here is funny, send nothing.",
        active: false,
    },
    {
        id: "vedalroast",
        name: "Roast Vedal",
        judge: "decision",
        question: GOOD_MOMENT,
        when: "yes",
        stat: "stat:vedalroast",
        stat_min: 250,
        stat_max: 300,
        advice: "It has been a long while since they last had a go at Vedal's bald turtle head. Find an opening for it in this conversation, however thin, and an angle on it they have not used before. If there is no way in at all, send nothing.",
        active: false,
    },
    {
        id: "move",
        name: "Time to move",
        judge: "decision",
        question: GOOD_MOMENT,
        when: "yes",
        stat: "tool:play_gesture",
        stat_min: 100,
        stat_max: 130,
        advice: "They have not made a gesture in a long while. Remind them they have a body, and name the kind of moment coming up in this conversation where one would land.",
        active: false,
    },
];
// A fresh row for "Add rule" / "Add moment" - same key order.
const NEW_COACH_RULE = {
    id: "", name: "", judge: "decision", question: "", when: "yes", stat: "", stat_min: 0, stat_max: 0, advice: "",
    active: true,
};
// Tools a rule can wait on before the companion has ever been seen calling
// them; any other tool joins the list once it has been called on a call.
const KNOWN_TOOLS = [
    "play_gesture", "set_emotion", "generate_gesture", "move_around", "change_outfit", "change_background",
    "play_background_music", "create_image", "create_video", "create_voicemail", "perform_song",
    "remember", "recall", "recall_stories", "adjust_affection",
];
// What the coach can look things up with (server/coach.py COACH_TOOLS).
const COACH_TOOLS = [
    ["web_search", "Search the web"],
    ["x_search", "Search X (a Grok brain only)"],
];

function parseList(text) {
    try {
        const list = JSON.parse(text || "[]");
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function clampInt(value, lo, hi, fallback) {
    const v = parseInt(value, 10);
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** A rule's or a tracked moment's id: what its counters are kept under, so
 *  renaming it keeps its count (server/coach.py clean_rules, clean_moments). */
function newId() {
    return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

/** The "Conversation coach" section of the companion editor: the switch,
 *  the brain the coach thinks on and what it may look up, the tracked
 *  moments, and the rule list - laid out like the idle events list (rows
 *  with an inline Active switch; an edit card that works on a copy).
 *  Everything lives in the companion draft (agents.coach_*), so the main
 *  Save persists it like any other field and commits an open card too
 *  (lib/child_editor.js). */
export default function CoachSection({ editingAgent, setEditingAgent, idScope, registerEditor, voiceSetups }) {
    const rules = parseList(editingAgent.coach_rules);
    const moments = parseList(editingAgent.coach_moments).filter((m) => m && typeof m === "object");
    const coachTools = parseList(editingAgent.coach_tools);
    const patchAgent = (patch) => setEditingAgent({ ...editingAgent, ...patch });
    // The open card's copy; _index = the row it edits, null = a new rule.
    const [draft, setDraft] = useState(null);
    const setD = (patch) => setDraft((d) => ({ ...d, ...patch }));
    const setRules = (next) => patchAgent({ coach_rules: JSON.stringify(next) });
    const setRule = (i, patch) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const removeRule = (i) => {
        setRules(rules.filter((_, j) => j !== i));
        // An open card keeps pointing at its own row.
        setDraft((d) => (d && d._index != null && d._index > i ? { ...d, _index: d._index - 1 } : d));
    };
    const draftComplete = (d) => !!(d.advice || "").trim() && (d.judge === "coach" || !!(d.question || "").trim());
    const withDraft = (d) => {
        const rule = {
            id: d.id || newId(), name: d.name, judge: d.judge, question: d.question, when: d.when,
            stat: d.stat, stat_min: clampInt(d.stat_min, 0, 100000, 0),
            stat_max: clampInt(d.stat_max ?? d.stat_min, clampInt(d.stat_min, 0, 100000, 0), 100000, 0),
            advice: d.advice, active: d.active,
        };
        return d._index == null ? [rule, ...rules] : rules.map((r, j) => (j === d._index ? rule : r));
    };
    const saveDraft = () => {
        setRules(withDraft(draft));
        setDraft(null);
    };
    // Only while the coach is on: switched off, the card is not on screen,
    // and a draft nobody can see must neither block Save nor be saved.
    const coachOn = !!editingAgent.coach_enabled;
    useRegisterChildEditor(registerEditor, coachOn && editorDirty(draft), async () => {
        if (!coachOn || !draft || !editorDirty(draft)) return true;
        if (!draftComplete(draft)) {
            notification.add(
                _t("The open coach rule is missing its question or what to ask the coach for — finish it or cancel it, then save again."),
                { type: "warning" });
            return false;
        }
        const coach_rules = JSON.stringify(withDraft(draft));
        setDraft(null);
        return { coach_rules };
    });

    const setMoments = (next) => patchAgent({ coach_moments: JSON.stringify(next) });
    const setMoment = (i, patch) => setMoments(moments.map((m, j) => (j === i ? { ...m, ...patch } : m)));
    const toggleTool = (id) => patchAgent({
        // In COACH_TOOLS order, as the server writes it.
        coach_tools: JSON.stringify(COACH_TOOLS.map(([t]) => t)
            .filter((t) => (t === id ? !coachTools.includes(t) : coachTools.includes(t)))),
    });
    /** The example moments and rules that are not in the lists yet. */
    const withExamples = () => ({
        coach_moments: JSON.stringify([...moments,
            ...EXAMPLE_COACH_MOMENTS.filter((e) => !moments.some((m) => m.id === e.id))]),
        coach_rules: JSON.stringify([...rules,
            ...EXAMPLE_COACH_RULES.filter((e) => !rules.some((r) => r.id === e.id || r.name === e.name))]),
    });

    // This companion's counters, as they stood when the editor opened.
    const enabled = !!editingAgent.coach_enabled;
    const [counts, setCounts] = useState({});
    useEffect(() => {
        if (!enabled || editingAgent.id == null) return;
        rpc("/api/voice/coach/counts", { agent_id: editingAgent.id })
            .then((res) => setCounts(res?.counts || {})).catch(() => {});
    }, [enabled, editingAgent.id]);

    // What a rule can wait on: [stored key, label].
    const tools = [...new Set([
        ...KNOWN_TOOLS,
        ...Object.keys(counts).filter((k) => k.startsWith("tool:")).map((k) => k.slice(5)),
    ])];
    const waitOptions = [
        ["rule", _t("this rule last went to the coach")],
        ["note", _t("the coach last sent a thought")],
        ...moments.map((m) => [`stat:${m.id}`, _t("tracked moment: %s", m.name || m.question)]),
        ...tools.map((name) => [`tool:${name}`, _t("tool: %s", name)]),
    ];
    const waitLabel = (key) => waitOptions.find(([k]) => k === key)?.[1] || _t("(missing: %s)", key);
    const countOf = (rule) => counts[rule.stat === "rule" ? `rule:${rule.id}` : rule.stat];
    const preview = (text) => (text.length > 90 ? `${text.slice(0, 89)}…` : text);
    const waitRange = (r) => ((r.stat_max ?? r.stat_min) > r.stat_min ? `${r.stat_min}–${r.stat_max}` : `${r.stat_min ?? 0}+`);
    // Clamp on leaving a field, not per keystroke - typing "30" passes
    // through "3", below the other end of the range.
    const clampWait = () => setDraft((d) => {
        const lo = clampInt(d.stat_min, 0, 100000, 0);
        return { ...d, stat_min: lo, stat_max: clampInt(d.stat_max ?? lo, lo, 100000, lo) };
    });
    const summary = (r) => [
        r.stat && _t("%s replies since %s", waitRange(r), waitLabel(r.stat)),
        r.judge === "coach" ? _t("coach decides") : r.when === "no" ? _t("when the answer is no") : _t("when the answer is yes"),
        r.active === false && _t("inactive"),
    ].filter(Boolean).join(" · ");
    const setups = (voiceSetups?.options || []).filter((o) => o.value !== "realtime");

    const card = draft && (
        <div className="rx_agent_editor" style={{ marginTop: "0.5rem" }}>
            <label>{_t("Name")}</label>
            <input type="text" value={draft.name || ""} placeholder={_t("e.g. Time for a joke")}
                   onChange={(ev) => setD({ name: ev.target.value })} />
            <div className="rx_row">
                <div>
                    <label title={_t("An optional wait before this rule is looked at: so many of the companion's replies since something last happened. With two different numbers the wait is a random length between them, drawn again each time the rule fires, so rules don't come due like clockwork or all at once. A count starts at zero when it is first asked for, so nothing is overdue on the first call. When the rule fires, it waits the whole length again whether or not the companion acts on the thought. 'This rule' makes the rule look at most once every so many replies.")}>
                        {_t("Wait for")}
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <input type="number" min={0} max={100000} style={{ width: "5.5rem" }} disabled={!draft.stat}
                               value={draft.stat_min ?? 0}
                               onChange={(ev) => setD({ stat_min: ev.target.value === "" ? "" : Number(ev.target.value) })}
                               onBlur={clampWait} />
                        <span className="text-muted">{_t("to")}</span>
                        <input type="number" min={0} max={100000} style={{ width: "5.5rem" }} disabled={!draft.stat}
                               value={draft.stat_max ?? draft.stat_min ?? 0}
                               onChange={(ev) => setD({ stat_max: ev.target.value === "" ? "" : Number(ev.target.value) })}
                               onBlur={clampWait} />
                        <span className="text-muted">{_t("replies since")}</span>
                    </div>
                </div>
                <div style={{ flex: 3 }}>
                    <label>&nbsp;</label>
                    <select value={draft.stat || ""} onChange={(ev) => setD({ stat: ev.target.value })}>
                        <option value="">{_t("(no wait)")}</option>
                        {draft.stat && !waitOptions.some(([k]) => k === draft.stat) && (
                            <option value={draft.stat}>{waitLabel(draft.stat)}</option>
                        )}
                        {waitOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                </div>
            </div>
            <div className="rx_row">
                <div style={{ flex: 2 }}>
                    <label title={_t("Who decides the moment has come, once the wait is over. The coach model reads the whole conversation and decides for itself - a full coach request every time the rule is looked at, so give it a wait. The decision model (Settings → Decision model) answers a yes/no question about the last few lines first - quick and cheap - and the coach only runs on the answer you pick.")}>
                        {_t("Decided by")}
                    </label>
                    <select value={draft.judge === "coach" ? "coach" : "decision"} onChange={(ev) => setD({ judge: ev.target.value })}>
                        <option value="decision">{_t("The decision model, from a question")}</option>
                        <option value="coach">{_t("The coach model itself")}</option>
                    </select>
                </div>
                {draft.judge !== "coach" && (
                    <div>
                        <label title={_t("Which answer brings the coach in. 'No' suits questions about something that has been missing.")}>
                            {_t("Ask the coach when the answer is")}
                        </label>
                        <select value={draft.when === "no" ? "no" : "yes"} onChange={(ev) => setD({ when: ev.target.value })}>
                            <option value="yes">{_t("Yes")}</option>
                            <option value="no">{_t("No")}</option>
                        </select>
                    </div>
                )}
            </div>
            {draft.judge !== "coach" && (
                <>
                    <label title={_t("A yes/no question about the last few lines of the call. Write `conversation` for those lines, `last_reply` for the companion's latest one, and `character` for who the companion is (their name and personality). Ask about one thing that either happened or did not: a narrow question fires seldom, a broad one all the time.")}>
                        {_t("Question about the conversation")}
                    </label>
                    <textarea rows={2} value={draft.question || ""}
                              placeholder={_t("e.g. 'Is `conversation` at a point where something new could come in naturally?'")}
                              onChange={(ev) => setD({ question: ev.target.value })} />
                </>
            )}
            <label title={_t("What the coach is asked to work out when this rule fires. The coach reads the companion's whole prompt, the whole conversation and the counts, then writes the companion a short thought - or nothing, if it finds no opening.")}>
                {_t("What to ask the coach for")}
            </label>
            <textarea rows={3} value={draft.advice || ""}
                      placeholder={_t("e.g. 'Find an opening to bring up the fishing trip again.'")}
                      onChange={(ev) => setD({ advice: ev.target.value })} />
            <span className="rx_check" style={{ marginTop: "0.25rem" }}>
                <input id={`coach-${idScope}-active`} type="checkbox" checked={draft.active !== false}
                       onChange={(ev) => setD({ active: ev.target.checked })} />
                <label htmlFor={`coach-${idScope}-active`}>{_t("Active")}</label>
            </span>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button className="btn btn-sm" disabled={!draftComplete(draft)} onClick={saveDraft}>
                    {_t("Save rule")}
                </button>
                <button className="btn btn-sm" onClick={() => setDraft(null)}>{_t("Cancel")}</button>
            </div>
        </div>
    );

    return (
        <section>
            <h3><i className="fa fa-commenting-o" /> {_t("Conversation coach")}</h3>
            <p className="text-muted small" style={{ margin: "0 0 0.25rem" }}>
                {_t("A second model reads this companion's voice calls from the side. When one of the rules below fires - it has been a while since a joke, a gesture, a running gag - it looks for an opening and hands the companion a short thought of their own before one of their next replies. Replies never wait for it. Works in group calls too, each companion with its own coach. Takes effect from the next call.")}
            </p>
            <span className="rx_check">
                <input id={`flag-${idScope}-coach_enabled`} type="checkbox"
                       checked={enabled}
                       onChange={(ev) => {
                           const on = ev.target.checked ? 1 : 0;
                           // First switch-on with empty lists seeds the
                           // examples, all inactive; existing lists are kept.
                           patchAgent({ coach_enabled: on, ...(on && !rules.length && !moments.length ? withExamples() : {}) });
                       }} />
                <label htmlFor={`flag-${idScope}-coach_enabled`}>
                    {_t("Enable the conversation coach on voice calls")}
                </label>
            </span>
            {enabled && (
                <>
                    <div className="rx_row">
                        <div>
                            <label title={_t("The model the coach thinks on: the text chat brain of one of your voice setups (Settings → Models & providers), so a call on a fast voice model can be coached by a slower one that reasons. The conversation is sent to that model's provider.")}>
                                {_t("Coach brain")}
                            </label>
                            <select value={editingAgent.coach_setup || ""}
                                    onChange={(ev) => patchAgent({ coach_setup: ev.target.value })}>
                                <option value="">{_t("This companion's text chat brain")}</option>
                                {voiceSetups && editingAgent.coach_setup
                                    && !setups.some((o) => o.value === editingAgent.coach_setup) && (
                                    <option value={editingAgent.coach_setup}>
                                        {_t("(setup no longer exists - the coach is off until you pick a brain)")}
                                    </option>
                                )}
                                {setups.map((o) => (
                                    <option key={o.value} value={o.value}>
                                        {o.brain ? `${_t(o.label)}: ${o.brain}` : _t(o.label)}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label title={_t("What the coach may use to look things up before it writes a thought - a fact, a name, something recent. The search runs at the brain's provider, so it needs a brain whose provider offers it (Grok, OpenAI, Claude); a local model has none. Each search adds a few seconds and its cost. Settings' search limit for a text reply applies.")}>
                                {_t("The coach can")}
                            </label>
                            {COACH_TOOLS.map(([id, label]) => (
                                <span key={id} className="rx_check">
                                    <input id={`coach-${idScope}-tool-${id}`} type="checkbox"
                                           checked={coachTools.includes(id)} onChange={() => toggleTool(id)} />
                                    <label htmlFor={`coach-${idScope}-tool-${id}`}>{_t(label)}</label>
                                </span>
                            ))}
                        </div>
                        <div>
                            <label title={_t("After the coach sends a thought, no rule is looked at until the companion has given this many replies - so rules that came due together during a long scene are handed over one at a time, spaced out, rather than back to back. One rule fires per reply at most, the most overdue first. 0 = no spacing.")}>
                                {_t("Replies between thoughts")}
                            </label>
                            <input type="number" min={0} max={100000} style={{ width: "5.5rem" }}
                                   value={editingAgent.coach_gap ?? 0}
                                   onChange={(ev) => patchAgent({ coach_gap: clampInt(ev.target.value, 0, 100000, 0) })} />
                        </div>
                    </div>
                    <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.75rem 0 0.25rem" }}>
                            <strong>{_t("Tracked moments")}</strong>
                            <button className="btn btn-sm"
                                    onClick={() => setMoments([...moments, { id: newId(), name: "", question: "", active: true }])}>
                                <i className="fa fa-plus" /> {_t("Add moment")}
                            </button>
                        </div>
                        <p className="text-muted small" style={{ margin: "0.25rem 0" }}>
                            {_t("A yes/no question the decision model answers about every reply, only to keep count: 'Did the companion make a joke in `last_reply`?' gives a rule a 'replies since the last joke' to wait on. Counts are in this companion's own replies, start at zero and carry over from one call to the next. Requires a decision model (Settings → Decision model). A moment an active rule waits on is counted even when it is switched off here.")}
                        </p>
                        {!moments.length && (
                            <p className="text-muted small" style={{ margin: "0.25rem 0" }}>{_t("No tracked moments yet.")}</p>
                        )}
                        {moments.map((m, i) => (
                            <div key={m.id} className="rx_row" style={{ alignItems: "flex-end" }}>
                                <input type="checkbox" checked={m.active !== false} title={_t("Active")}
                                       style={{ flex: "0 0 auto", marginBottom: "0.6rem" }}
                                       onChange={() => setMoment(i, { active: m.active === false })} />
                                <div>
                                    <input type="text" value={m.name || ""} placeholder={_t("Name, e.g. Joke")}
                                           onChange={(ev) => setMoment(i, { name: ev.target.value })} />
                                </div>
                                <div style={{ flex: 3 }}>
                                    <input type="text" value={m.question || ""}
                                           placeholder={_t("e.g. 'Did the companion make a joke in `last_reply`?'")}
                                           onChange={(ev) => setMoment(i, { question: ev.target.value })} />
                                </div>
                                <button className="btn btn-sm btn-link p-0" title={_t("Remove")}
                                        style={{ flex: "0 0 auto", marginBottom: "0.6rem" }}
                                        onClick={() => setMoments(moments.filter((_, j) => j !== i))}>
                                    <i className="fa fa-trash-o" />
                                </button>
                            </div>
                        ))}
                    </>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "0.75rem 0 0.25rem" }}>
                        <strong>{_t("Rules")}</strong>
                        <span style={{ display: "flex", gap: "0.5rem" }}>
                            <button className="btn btn-sm" title={_t("Adds the example tracked moments and rules that are not in the lists yet, switched off.")}
                                    onClick={() => patchAgent(withExamples())}>
                                {_t("Add the examples")}
                            </button>
                            <button className="btn btn-sm"
                                    onClick={() => setDraft(withEditorSnapshot({ ...NEW_COACH_RULE, _index: null }))}>
                                <i className="fa fa-plus" /> {_t("Add rule")}
                            </button>
                        </span>
                    </div>
                    {draft && draft._index == null && card}
                    {!rules.length && !draft && (
                        <p className="text-muted small" style={{ margin: "0.25rem 0" }}>{_t("No rules yet.")}</p>
                    )}
                    {rules.map((r, i) => (draft && draft._index === i) ? (
                        <React.Fragment key={i}>{card}</React.Fragment>
                    ) : (
                        <div key={i} className="rx_memory_row">
                            <input type="checkbox" checked={r.active !== false} title={_t("Active")}
                                   onChange={() => setRule(i, { active: r.active === false })} />
                            <strong>{r.name || _t("(unnamed)")}</strong>
                            <span className="rx_memory_content text-muted small">
                                {r.advice ? preview(r.advice) : _t("(no advice)")}
                            </span>
                            <span className="rx_memory_meta">
                                {summary(r)}{r.stat && countOf(r) != null ? ` (${_t("now %s", countOf(r))})` : ""}
                            </span>
                            <button className="btn btn-sm btn-link p-0"
                                    onClick={() => setDraft(withEditorSnapshot({ ...NEW_COACH_RULE, ...r, _index: i }))}>
                                {_t("Edit")}
                            </button>
                            <button className="btn btn-sm btn-link p-0" title={_t("Remove")} onClick={() => removeRule(i)}>
                                <i className="fa fa-trash-o" />
                            </button>
                        </div>
                    ))}
                </>
            )}
        </section>
    );
}
