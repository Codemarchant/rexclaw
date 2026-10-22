import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { morphLabel } from "../lib/morph_names";
import { avatarRenderer } from "../services/avatar_renderer";
import { FACE_TUNING, feelingParts } from "../services/face_motion";
import { IDLE_EVENTS } from "../services/idle_motion";
import AvatarCanvas from "./AvatarCanvas";

// What the preview buttons play: the face director's feelings (the ids the
// server reads a line into) and a few of the acts a line can carry, with
// the head move an act adds (not tunable here — only the face is).
const FEELINGS = ["warm", "happy", "teasing", "excited", "proud", "puzzled", "surprised",
    "embarrassed", "huffy", "worried", "scared", "sad", "annoyed"];
const ACTS = [
    ["affirms", "Nod", "a yes: a nod with the brows raised", "head nod"],
    ["negates", "Shake", "a no: a head shake with the brows knitted", "head shake"],
    ["winks", "Wink", "a wink at the end of the line", null],
    ["asked", "Glance", "looking away to think: up and aside for a few seconds, as when asked something or puzzled", null],
];
const MAX = 2;

// A feeling's levels, as the face director plays them: 1 and 2 hold as the
// mood, and 3 is a peak of a few seconds on top of level 2.
const LEVELS = [
    [1, "Level 1 · light"],
    [2, "Level 2 · clear (stays under a level-3 peak)"],
    [3, "Level 3 · peak (a few seconds over level 2, then fades back)"],
];
// Channels whose shapes can be chosen (not the eyes' turn or the emotions).
const mappable = (id) => id !== "gaze" && !id.startsWith("emotion:");

// The look's face_map as the dialog edits it, and back: an empty level or
// feeling is dropped, and an empty map is null (auto-detect everything).
// The first version's `moments` ({feeling, from, shapes}) read as shapes on
// each level from `from` up.
const loadMap = (m) => {
    const feelings = {};
    for (const [f, levels] of Object.entries(m?.feelings || {})) {
        feelings[f] = {};
        for (const [l, s] of Object.entries(levels || {})) {
            feelings[f][l] = { ...s, parts: { ...(s?.parts || {}) }, shapes: { ...(s?.shapes || {}) } };
        }
    }
    for (const x of m?.moments || []) {
        for (let l = x.from; l <= 3; l++) {
            const s = ((feelings[x.feeling] ||= {})[l] ||= { parts: {}, shapes: {} });
            s.shapes = { ...s.shapes, ...(x.shapes || {}) };
        }
    }
    return { channels: { ...(m?.channels || {}) }, feelings };
};
const setupEmpty = (s) => !s || (s.builtin !== false && !Object.keys(s.parts || {}).length
    && !Object.keys(s.shapes || {}).length);
const cleanMap = (m) => {
    const out = {};
    if (Object.keys(m.channels).length) out.channels = m.channels;
    const feelings = {};
    for (const [f, levels] of Object.entries(m.feelings)) {
        for (const [l, s] of Object.entries(levels)) {
            if (setupEmpty(s)) continue;
            const clean = {};
            if (s.builtin === false) clean.builtin = false;
            if (Object.keys(s.parts || {}).length) clean.parts = s.parts;
            if (Object.keys(s.shapes || {}).length) clean.shapes = s.shapes;
            (feelings[f] ||= {})[l] = clean;
        }
    }
    if (Object.keys(feelings).length) out.feelings = feelings;
    return Object.keys(out).length ? out : null;
};

/** Weighted entries ({key: weight}) as rows: a label, a slider and a number,
 *  and a remove button. */
function WeightRows({ value, max, labelOf: label, onChange }) {
    const set = (k, v) => onChange({ ...value, [k]: round(Math.max(0, Math.min(max, v))) });
    return Object.entries(value || {}).map(([k, w]) => (
        <div key={k} className="rx_face_shapes_row">
            <span title={label(k)}>{label(k)}</span>
            <input type="range" min="0" max={max} step="0.05" value={w}
                   onChange={(ev) => set(k, Number(ev.target.value))} />
            <input type="number" min="0" max={max} step="0.05" value={w}
                   onChange={(ev) => set(k, Number(ev.target.value) || 0)} />
            <button className="btn btn-sm btn-link" title={_t("Remove")}
                    onClick={() => { const next = { ...value }; delete next[k]; onChange(next); }}>
                <i className="fa fa-times" />
            </button>
        </div>
    ));
}

/** A search box over `options` ([{ key, label }]) with a scrolling list
 *  under it while it has focus; picking one calls `onPick(key)`. */
function SearchAdd({ options, placeholder, onPick }) {
    const [q, setQ] = useState("");
    const [open, setOpen] = useState(false);
    const needle = q.trim().toLowerCase();
    const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
    return (
        <div className="rx_face_search">
            <input className="form-control form-control-sm" value={q} placeholder={placeholder}
                   onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
                   onChange={(ev) => { setQ(ev.target.value); setOpen(true); }} />
            {open && (
                <div className="rx_face_search_list">
                    {shown.length ? shown.map((o) => (
                        <button key={o.key} type="button" className="rx_face_search_item"
                                onMouseDown={(ev) => ev.preventDefault()}
                                onClick={() => { onPick(o.key); setQ(""); }}>
                            {o.label}
                        </button>
                    )) : <div className="text-muted small px-2 py-1">{_t("No match")}</div>}
                </div>
            )}
        </div>
    );
}

/** The model's own shapes with a weight each, and a search to add more.
 *  `value` {morph: weight}; `children` go under it. */
function ShapePicker({ names, value, max, note, onChange, children }) {
    const chosen = value || {};
    return (
        <div className="rx_face_shapes">
            {note && <div className="text-muted small">{note}</div>}
            <WeightRows value={chosen} max={max} labelOf={morphLabel} onChange={onChange} />
            <SearchAdd placeholder={_t("Add a shape… (search by name or meaning)")}
                       options={names.filter((n) => !(n in chosen)).map((n) => ({ key: n, label: morphLabel(n) }))}
                       onPick={(n) => onChange({ ...chosen, [n]: 1 })} />
            {children}
        </div>
    );
}

const round = (v) => Math.round(v * 100) / 100;
// A channel's size: metres of vertex travel, or degrees for the eyes' turn.
const size = (v, unit) => (unit === "deg" ? `${v.toFixed(1)}°` : `${(v * 100).toFixed(2)} cm`);
const LABELS = Object.fromEntries(FACE_TUNING.flatMap((g) => g.channels.map((c) => [c.id, c.label])));
const labelOf = (id) => (id.startsWith("shape:") ? id.slice(6) : _t(LABELS[id] || id));

/** Tune how strongly the face director (and the companion's own emotions)
 *  play on one look's model: a slider per face part, 1 = the shapes as the
 *  model's author drew them, and one per individual shape for parts made
 *  of several. The shared renderer shows the model's face close up while
 *  the dialog is open, playing the tuned values live, and lights up the
 *  sliders each button uses; the avatar on screen before is put back on
 *  close. `onApply` gets only the values that differ from 1 (an empty
 *  object = untuned), and the look's face_map (`mapValue`): the model's
 *  own shapes chosen for a part, and per feeling and level its own setup —
 *  the built-in parts kept or dropped, parts and shapes added at weights
 *  of its own — or null for none. */
// The look's body tuning (pose_tuning): the arm spread, degrees either side
// of the hang measured from the mesh (server/avatar_packs.py
// POSE_ARM_SPREAD_RANGE), and per idle event whether the idle plays it.
const ARM_SPREAD_MIN = -10;
const ARM_SPREAD_MAX = 25;
// The idle events' names and tooltips, by IDLE_EVENTS id.
const IDLE_EVENT_TEXT = {
    weight_shift: ["Weight shifts",
        "Now and then, when standing idle, the companion moves their weight onto one leg, or out and back, and the hips sway with it. Turn it off to keep the weight on both legs (a hand on the hip still leans onto its side)."],
    hand_on_hip: ["Hand on hip",
        "Now and then, when standing idle, the companion rests a hand on the hip. Turn it off for a model the pose doesn't suit."],
};

export default function FaceTuningDialog({ title, vrmUrl, idleUrl, value, mapValue, poseValue, onApply, onClose }) {
    const [draft, setDraft] = useState(() => ({ ...(value || {}) }));
    const [pose, setPose] = useState(() => ({ ...(poseValue || {}) }));
    const [map, setMap] = useState(() => loadMap(mapValue));
    const [names, setNames] = useState([]);       // the model's morph names
    const [auto, setAuto] = useState({});         // what rexclaw finds per part by itself
    const [picking, setPicking] = useState(null); // the part whose shapes are open
    const [feelingOpen, setFeelingOpen] = useState(null); // the feeling being set up
    const [sizes, setSizes] = useState(null);
    const [shapes, setShapes] = useState([]);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(false);
    const [view, setView] = useState("face");     // the preview's framing: face | head | full
    const [playing, setPlaying] = useState(null);   // { label, used: Set, head }
    const last = useRef(null);   // the last thing played, replayed after a slider moves

    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Take the renderer over for the preview, and hand it back.
    useEffect(() => {
        const r = avatarRenderer;
        const before = {
            url: r._loadedVrmUrl,
            idle: r._currentAvatarPayload?.vrma_idle_url || null,
            face: !!r._face?.on,
        };
        let live = true;
        (async () => {
            try {
                await r.loadVRM(vrmUrl);
                if (idleUrl) await r.loadVRMA(idleUrl).catch(() => {});
                if (!live) return;
                r.setFaceDirector(true);
                r.setCloseUp("face");
                setSizes(r.faceTuningSizes());
                setShapes(r.faceTuningShapes());
                setNames(r.faceMorphNames());
                const found = {};
                for (const { channels } of FACE_TUNING) {
                    for (const { id } of channels) if (mappable(id)) found[id] = r.faceAutoSource(id);
                }
                setAuto(found);
            } catch (e) {
                if (live) setError(e?.message || _t("Could not load this model."));
            }
        })();
        return () => {
            live = false;
            r.setCloseUp(null);
            r.setFaceTuningPreview(null);
            r.setPoseTuningPreview(null);
            r.setFaceMapPreview(null);
            r._face?.clear({ snap: true });
            r.setEmotion?.("neutral", { explicit: false });
            r.setFaceDirector(before.face);
            if (before.url && before.url !== vrmUrl) {
                r.loadVRM(before.url)
                    .then(() => before.idle && r.loadVRMA(before.idle))
                    .catch((e) => console.error("[face tuning] could not restore the avatar", e));
            }
        };
    }, [vrmUrl, idleUrl]);

    useEffect(() => {
        avatarRenderer.setFaceTuningPreview(draft);
    }, [draft]);

    useEffect(() => {
        avatarRenderer.setPoseTuningPreview(pose);
    }, [pose]);
    const spread = pose.arm_spread ?? 0;
    // Moving the arms shows the whole figure: they are out of a close-up.
    const setSpread = (v) => {
        setPose((p) => ({ ...p, arm_spread: Math.round(Math.max(ARM_SPREAD_MIN, Math.min(ARM_SPREAD_MAX, v))) }));
        setView("full");
    };

    // The mapping plays live too; a part's size follows the shapes chosen.
    useEffect(() => {
        avatarRenderer.setFaceMapPreview(cleanMap(map) || { channels: {}, feelings: {} });
        if (sizes) {
            setSizes(avatarRenderer.faceTuningSizes());
            setShapes(avatarRenderer.faceTuningShapes());
        }
    }, [map]);

    // The canvas host changes size with the layout: re-frame the view.
    useEffect(() => {
        if (sizes) avatarRenderer.setCloseUp(view);
    }, [view, expanded, sizes]);

    const play = (thing) => {
        last.current = thing;
        const r = avatarRenderer;
        // Each play starts from a neutral face: a feeling's mood holds until
        // the next one, and an own emotion (set_emotion) makes the director
        // stand aside while it lasts — either would hide what plays next.
        r._face?.clear({ snap: true });
        r.setEmotion?.("neutral", { explicit: false, settle: true });
        const used = r.recordFaceChannels(() => {
            if (thing.channel) {
                r.previewFaceChannel(thing.channel);
            } else {
                r.setFaceReaction({
                    top: thing.feeling || null,
                    feelings: thing.feeling ? { [thing.feeling]: 1 } : {},
                    level: thing.level || 0,
                    acts: thing.act ? [thing.act] : [],
                    words: {},
                }, { first: true });
            }
        });
        if (thing.channel) used.add(thing.channel);
        setPlaying({ label: thing.label, used, head: thing.head || null });
    };
    const replay = () => last.current && play(last.current);

    const set = (id, v) => setDraft((d) => ({ ...d, [id]: round(Math.max(0, Math.min(MAX, v))) }));
    const strength = (id) => draft[id] ?? 1;

    // Scale down every part this model draws bigger than a typical VRoid
    // model; never up (FACE_TUNING's `ref`). Single shapes
    // are left alone — they are for what a part-wide scale can't fix.
    const autoTune = () => {
        if (!sizes) return;
        const next = { ...draft };
        for (const { channels } of FACE_TUNING) {
            for (const { id, ref } of channels) {
                const got = sizes[id];
                if (ref && got) next[id] = got > ref ? round(ref / got) : 1;
            }
        }
        setDraft(next);
    };

    const apply = () => {
        const out = {};
        for (const [k, v] of Object.entries(draft)) if (v !== 1) out[k] = v;
        const body = {};
        if (spread) body.arm_spread = spread;
        for (const { id } of IDLE_EVENTS) if (pose[id] === false) body[id] = false;
        onApply(out, cleanMap(map), body);
    };

    // A part's own shapes: an object sets them ({} = off), undefined goes
    // back to what rexclaw finds by itself.
    const setChannel = (id, shapesOf) => setMap((m) => {
        const channels = { ...m.channels };
        if (shapesOf === undefined) delete channels[id];
        else channels[id] = shapesOf;
        return { ...m, channels };
    });
    // A feeling's own setup at a level ({ builtin, parts, shapes }).
    const setupOf = (f, l) => map.feelings[f]?.[l] || { parts: {}, shapes: {} };
    const setSetup = (f, l, patch) => setMap((m) => ({
        ...m,
        feelings: { ...m.feelings, [f]: { ...(m.feelings[f] || {}), [l]: { ...setupOf(f, l), ...patch } } },
    }));
    const changed = (f) => [1, 2, 3].filter((l) => !setupEmpty(map.feelings[f]?.[l]));
    // Every part the face can play, for adding one to a feeling's level.
    const partOptions = FACE_TUNING.flatMap((g) => g.channels).filter(({ id }) => mappable(id))
        .map(({ id, label }) => ({ key: id, label: _t(label) }));
    // Everything back: the sliders, the parts' shapes and the feelings.
    const resetAll = () => {
        setDraft({});
        setMap({ channels: {}, feelings: {} });
        setPose({});
        setPicking(null);
    };

    // Where a part's shapes come from, for its picker.
    const sourceNote = (id) => {
        const own = map.channels[id];
        if (own && !Object.keys(own).length) return _t("Off: this part shows nothing on this model.");
        if (own) return _t("Your shapes, in place of what rexclaw finds:");
        const a = auto[id];
        if (!a) return _t("Not on this model. Add its shapes to use it.");
        if (a.kind === "shapes") return `${_t("Found by name")}: ${a.names.join(", ")}`;
        if (a.kind === "half") return _t("From the model's own emotion expressions (their eye or mouth half).");
        return `${_t("From the model's expression")}: ${a.names.join(", ")}`;
    };

    const row = ({ id, label, hint, disabled = false, extra = <span /> }) => (
        <div key={id} className={`rx_face_tuning_row${playing?.used.has(id) ? " is-used" : ""}${disabled ? " is-missing" : ""}`}>
            <button className="btn btn-sm btn-link" title={_t("Play")} disabled={disabled}
                    onClick={() => play({ channel: id, label })}>
                <i className="fa fa-play" />
            </button>
            <label htmlFor={`rx_ft_${id}`} title={hint}>{label}</label>
            <input id={`rx_ft_${id}`} type="range" min="0" max={MAX} step="0.05"
                   value={strength(id)} disabled={disabled}
                   onChange={(ev) => set(id, Number(ev.target.value))}
                   onPointerUp={replay} onKeyUp={replay} />
            <input type="number" min="0" max={MAX} step="0.05"
                   value={strength(id)} disabled={disabled}
                   onChange={(ev) => set(id, Number(ev.target.value) || 0)} />
            {extra}
        </div>
    );

    const usedLabels = playing
        ? [...playing.used].filter((id) => !id.startsWith("shape:")).map(labelOf)
        : [];

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className={`rx_dialog rx_dialog--face_tuning${expanded ? " is-expanded" : ""}`}
                 role="dialog" aria-modal="true" onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Tune model")}{title ? ` — ${title}` : ""}</h4>
                {!expanded && (
                    <p className="small">
                        {_t("How strongly each part of the face moves on this model. 1 plays the "
                            + "shapes as the model's author drew them. Auto-tune scales down the parts "
                            + "this model draws bigger than a typical VRoid model. Play a part, a "
                            + "feeling or a gesture to see it; the sliders it uses light up.")}
                    </p>
                )}
                <div className="rx_face_tuning_body">
                    <div className="rx_face_tuning_preview">
                        <div className="rx_face_tuning_stage">
                            <AvatarCanvas size="mini" />
                            <div className="rx_face_tuning_view">
                                {[
                                    ["face", "fa-smile-o", "Face close up"],
                                    ["head", "fa-user", "Head and shoulders"],
                                    ["full", "fa-male", "Full body"],
                                ].map(([id, icon, label]) => (
                                    <button key={id} className={`btn btn-sm ${view === id ? "btn-primary" : "btn-light"}`}
                                            onClick={() => setView(id)}
                                            title={`${_t(label)} — ${_t("drag to turn, scroll to zoom")}`}>
                                        <i className={`fa ${icon}`} />
                                    </button>
                                ))}
                                <button className="btn btn-sm btn-light" onClick={() => setExpanded((v) => !v)}
                                        title={expanded ? _t("Back to the normal size") : _t("Pop out: a bigger preview beside the sliders")}>
                                    <i className={`fa ${expanded ? "fa-compress" : "fa-expand"}`} />
                                </button>
                            </div>
                        </div>
                        <div className="rx_face_tuning_now small">
                            {playing
                                ? <>
                                    <strong>{playing.label}</strong>
                                    {" → "}
                                    {usedLabels.length ? usedLabels.join(", ") : _t("no face part on this model")}
                                    {playing.head ? ` (+ ${_t(playing.head)})` : ""}
                                </>
                                : <span className="text-muted">{_t("Nothing played yet.")}</span>}
                        </div>
                        <div className="rx_face_tuning_plays">
                            {FEELINGS.map((f) => (
                                <span key={f} className="rx_face_tuning_feeling">
                                    <span>{_t(f)}</span>
                                    {[1, 2, 3].map((level) => (
                                        <button key={level} className="btn btn-sm btn-light"
                                                title={_t("Play this feeling at level %s").replace("%s", level)}
                                                onClick={() => play({ feeling: f, level, label: `${_t(f)} · ${level}` })}>
                                            {level}
                                        </button>
                                    ))}
                                </span>
                            ))}
                            <span className="rx_face_tuning_feeling">
                                {ACTS.map(([act, label, hint, head]) => (
                                    <button key={act} className="btn btn-sm btn-light" title={_t(hint)}
                                            onClick={() => play({ act, label: _t(label), head })}>{_t(label)}</button>
                                ))}
                            </span>
                        </div>
                        <p className="text-muted small rx_face_tuning_levels">
                            {_t("Levels: 1 light, 2 clear, 3 peak. A slider scales its part at every level.")}
                        </p>
                    </div>
                    <div className="rx_face_tuning_sliders">
                        {error && <p className="text-danger">{error}</p>}
                        {!sizes && !error && <p className="text-muted">{_t("Loading the model…")}</p>}
                        {sizes && (
                            <div className="rx_face_tuning_group">
                                <h5>{_t("Body")}</h5>
                                <div className="rx_face_tuning_row">
                                    <span />
                                    <label htmlFor="rx_ft_arm_spread"
                                           title={_t("How far the arms hang out from the body when standing idle, in degrees on top of what rexclaw measures for this model. Raise it if the hands or arms go through the hips or a skirt; lower it if they hang too wide. Not used when the avatar has its own idle animation.")}>
                                        {_t("Arm spread")}
                                    </label>
                                    <input id="rx_ft_arm_spread" type="range" min={ARM_SPREAD_MIN} max={ARM_SPREAD_MAX}
                                           step="1" value={spread} onChange={(ev) => setSpread(Number(ev.target.value))} />
                                    <input type="number" min={ARM_SPREAD_MIN} max={ARM_SPREAD_MAX} step="1"
                                           value={spread} onChange={(ev) => setSpread(Number(ev.target.value) || 0)} />
                                    <span>°</span>
                                </div>
                            </div>
                        )}
                        {sizes && (
                            <div className="rx_face_tuning_group">
                                <h5 title={_t("What the companion does now and then while standing idle, for this model. Not used when the avatar has its own idle animation.")}>
                                    {_t("Procedural idle events")}
                                </h5>
                                {IDLE_EVENTS.map(({ id, perHour }) => {
                                    const on = pose[id] !== false;
                                    const [label, help] = IDLE_EVENT_TEXT[id];
                                    return (
                                        <div key={id} style={{ display: "flex", alignItems: "center" }}>
                                            <button className="btn btn-sm btn-link" title={_t("Play")} disabled={!on}
                                                    onClick={() => {
                                                        setView("full");
                                                        avatarRenderer.playIdleEvent(id);
                                                    }}>
                                                <i className="fa fa-play" />
                                            </button>
                                            <label className="rx_check" style={{ margin: 0 }} title={_t(help)}>
                                                <input type="checkbox" checked={on}
                                                       onChange={(ev) => setPose((p) => ({ ...p, [id]: ev.target.checked }))} />
                                                <span>{_t(label)}</span>
                                            </label>
                                            <span className="text-muted small" style={{ marginLeft: "0.5rem" }}>
                                                {_t("about %s an hour", Math.round(perHour))}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {sizes && FACE_TUNING.map(({ group, channels }) => {
                            // A part the model can't show stays listed when its
                            // shapes can be chosen, so they can be added.
                            const shown = channels.filter(({ id }) => sizes[id] != null || mappable(id));
                            if (!shown.length) return null;
                            return (
                                <div key={group} className="rx_face_tuning_group">
                                    <h5>{_t(group)}</h5>
                                    {shown.map(({ id, label, ref, unit }) => (
                                        <React.Fragment key={id}>
                                            {row({
                                                id,
                                                label: _t(label),
                                                hint: sizes[id] ? `${_t("This model")}: ${size(sizes[id], unit)}`
                                                    + (ref ? ` · ${_t("Typical")}: ${size(ref, unit)}` : "")
                                                    : _t("Not on this model"),
                                                disabled: sizes[id] == null,
                                                extra: mappable(id) ? (
                                                    <button className={`btn btn-sm btn-link${id in map.channels ? " is-set" : ""}`}
                                                            title={_t("Choose this part's shapes on the model")}
                                                            onClick={() => setPicking(picking === id ? null : id)}>
                                                        <i className="fa fa-crosshairs" />
                                                    </button>
                                                ) : <span />,
                                            })}
                                            {picking === id && (
                                                <ShapePicker names={names} value={map.channels[id]} max={MAX}
                                                             note={sourceNote(id)}
                                                             onChange={(s) => setChannel(id, s)}>
                                                    <div className="rx_face_shapes_actions">
                                                        <button className="btn btn-sm btn-light" disabled={!(id in map.channels)}
                                                                title={_t("Back to the shapes rexclaw finds by itself")}
                                                                onClick={() => setChannel(id, undefined)}>
                                                            {_t("Automatic")}
                                                        </button>
                                                        <button className="btn btn-sm btn-light"
                                                                title={_t("This part shows nothing on this model")}
                                                                onClick={() => setChannel(id, {})}>
                                                            {_t("Off")}
                                                        </button>
                                                    </div>
                                                </ShapePicker>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </div>
                            );
                        })}
                        {sizes && (
                            <div className="rx_face_tuning_group">
                                <h5>{_t("Feelings")}</h5>
                                <p className="text-muted small">
                                    {_t("What each feeling shows at each level. Keep or drop its built-in parts, "
                                        + "and add parts or the model's own shapes at weights of your own: heart "
                                        + "or star eyes, say, which look broken half-way, so give them 1.")}
                                </p>
                                {FEELINGS.map((f) => {
                                    const open = feelingOpen === f;
                                    const done = changed(f);
                                    return (
                                        <div key={f} className={`rx_face_feeling${open ? " is-open" : ""}`}>
                                            <button type="button" className="rx_face_feeling_head"
                                                    onClick={() => setFeelingOpen(open ? null : f)}>
                                                <i className={`fa fa-chevron-${open ? "down" : "right"}`} />
                                                <span>{_t(f)}</span>
                                                {done.length > 0 && (
                                                    <span className="rx_face_feeling_badge">
                                                        {_t("own at level")} {done.join(", ")}
                                                    </span>
                                                )}
                                            </button>
                                            {open && LEVELS.map(([l, levelLabel]) => {
                                                const s = setupOf(f, l);
                                                const builtin = feelingParts(f, l);
                                                return (
                                                    <div key={l} className="rx_face_level">
                                                        <div className="rx_face_level_head">
                                                            <button className="btn btn-sm btn-link" title={_t("Play this feeling at this level")}
                                                                    onClick={() => play({ feeling: f, level: l, label: `${_t(f)} · ${l}` })}>
                                                                <i className="fa fa-play" />
                                                            </button>
                                                            <strong>{_t(levelLabel)}</strong>
                                                        </div>
                                                        <label className="rx_face_level_builtin">
                                                            <input type="checkbox" checked={s.builtin !== false}
                                                                   disabled={!builtin.length}
                                                                   onChange={(ev) => setSetup(f, l, { builtin: ev.target.checked ? undefined : false })} />
                                                            {" "}{_t("Built-in parts")}:{" "}
                                                            {builtin.length
                                                                ? builtin.map(({ part, arrive }) => labelOf(part) + (arrive ? ` (${_t("as it arrives")})` : "")).join(", ")
                                                                : _t("none")}
                                                        </label>
                                                        <div className="rx_face_shapes">
                                                            <WeightRows value={s.parts} max={MAX} labelOf={labelOf}
                                                                        onChange={(p) => setSetup(f, l, { parts: p })} />
                                                            <SearchAdd placeholder={_t("Add a part…")}
                                                                       options={partOptions.filter((o) => !(o.key in (s.parts || {})))}
                                                                       onPick={(p) => setSetup(f, l, { parts: { ...(s.parts || {}), [p]: 1 } })} />
                                                        </div>
                                                        <ShapePicker names={names} value={s.shapes} max={MAX}
                                                                     onChange={(sh) => setSetup(f, l, { shapes: sh })} />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        {sizes && shapes.length > 0 && (
                            <details className="rx_face_tuning_group">
                                <summary><h5>{_t("Individual shapes")}</h5></summary>
                                <p className="text-muted small">
                                    {_t("The model's own shapes behind the parts above, for a part made of "
                                        + "several: the smiling eyes move both the eyes and the brows, for "
                                        + "example. These multiply with the part's slider.")}
                                </p>
                                {shapes.map(({ id, morph, size: s, channels }) => row({
                                    id,
                                    label: morphLabel(morph),
                                    hint: `${size(s)} · ${_t("used by")}: ${channels.map(labelOf).join(", ")}`,
                                }))}
                            </details>
                        )}
                    </div>
                </div>
                <div className="rx_dialog_actions">
                    <button className="btn btn-secondary me-auto" onClick={autoTune} disabled={!sizes}
                            title={_t("Scale down the parts this model draws bigger than a typical VRoid model")}>
                        <i className="fa fa-magic" /> {_t("Auto-tune")}
                    </button>
                    <button className="btn btn-secondary" onClick={resetAll}
                            title={_t("Everything back to the model as rexclaw finds it: every slider to 1, the parts' own shapes and the feelings' setups cleared")}>
                        {_t("Reset")}
                    </button>
                    <button className="btn btn-secondary" onClick={onClose}>{_t("Cancel")}</button>
                    <button className="btn btn-primary" onClick={apply}>{_t("Apply")}</button>
                </div>
            </div>
        </div>
    );
}
