import React, { useEffect, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { avatarRenderer } from "../services/avatar_renderer";
import { FACE_TUNING } from "../services/face_motion";
import AvatarCanvas from "./AvatarCanvas";

// What the preview buttons play: the face director's feelings (the ids the
// server reads a line into) and a few of the acts a line can carry, with
// the head move an act adds (not tunable here — only the face is).
const FEELINGS = ["warm", "happy", "teasing", "excited", "proud", "puzzled", "surprised",
    "embarrassed", "huffy", "worried", "sad", "annoyed"];
const ACTS = [
    ["affirms", "Nod", "a yes: a nod with the brows raised", "head nod"],
    ["negates", "Shake", "a no: a head shake with the brows knitted", "head shake"],
    ["winks", "Wink", "a wink at the end of the line", null],
];
const MAX = 2;

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
 *  object = untuned). */
export default function FaceTuningDialog({ title, vrmUrl, idleUrl, value, onApply, onClose }) {
    const [draft, setDraft] = useState(() => ({ ...(value || {}) }));
    const [sizes, setSizes] = useState(null);
    const [shapes, setShapes] = useState([]);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(false);
    const [closeUp, setCloseUp] = useState(true);
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
                r.setCloseUp(true);
                setSizes(r.faceTuningSizes());
                setShapes(r.faceTuningShapes());
            } catch (e) {
                if (live) setError(e?.message || _t("Could not load this model."));
            }
        })();
        return () => {
            live = false;
            r.setCloseUp(false);
            r.setFaceTuningPreview(null);
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

    // The canvas host changes size with the layout: re-frame the face.
    useEffect(() => {
        if (sizes) avatarRenderer.setCloseUp(closeUp);
    }, [closeUp, expanded, sizes]);

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
        onApply(out);
    };

    const row = ({ id, label, hint }) => (
        <div key={id} className={`rx_face_tuning_row${playing?.used.has(id) ? " is-used" : ""}`}>
            <button className="btn btn-sm btn-link" title={_t("Play")}
                    onClick={() => play({ channel: id, label })}>
                <i className="fa fa-play" />
            </button>
            <label htmlFor={`rx_ft_${id}`} title={hint}>{label}</label>
            <input id={`rx_ft_${id}`} type="range" min="0" max={MAX} step="0.05"
                   value={strength(id)}
                   onChange={(ev) => set(id, Number(ev.target.value))}
                   onPointerUp={replay} onKeyUp={replay} />
            <input type="number" min="0" max={MAX} step="0.05"
                   value={strength(id)}
                   onChange={(ev) => set(id, Number(ev.target.value) || 0)} />
        </div>
    );

    const usedLabels = playing
        ? [...playing.used].filter((id) => !id.startsWith("shape:")).map(labelOf)
        : [];

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className={`rx_dialog rx_dialog--face_tuning${expanded ? " is-expanded" : ""}`}
                 role="dialog" aria-modal="true" onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Tune face")}{title ? ` — ${title}` : ""}</h4>
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
                                <button className="btn btn-sm btn-light" onClick={() => setCloseUp((v) => !v)}
                                        title={_t("Switch between the face close up and head and shoulders")}>
                                    <i className={`fa ${closeUp ? "fa-search-minus" : "fa-search-plus"}`} />
                                </button>
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
                        {sizes && FACE_TUNING.map(({ group, channels }) => {
                            const shown = channels.filter(({ id }) => sizes[id] != null);
                            if (!shown.length) return null;
                            return (
                                <div key={group} className="rx_face_tuning_group">
                                    <h5>{_t(group)}</h5>
                                    {shown.map(({ id, label, ref, unit }) => row({
                                        id,
                                        label: _t(label),
                                        hint: sizes[id] ? `${_t("This model")}: ${size(sizes[id], unit)}`
                                            + (ref ? ` · ${_t("Typical")}: ${size(ref, unit)}` : "") : "",
                                    }))}
                                </div>
                            );
                        })}
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
                                    label: morph,
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
                    <button className="btn btn-secondary" onClick={() => setDraft({})}
                            title={_t("Every part back to 1, the shapes as drawn")}>
                        {_t("Reset")}
                    </button>
                    <button className="btn btn-secondary" onClick={onClose}>{_t("Cancel")}</button>
                    <button className="btn btn-primary" onClick={apply}>{_t("Apply")}</button>
                </div>
            </div>
        </div>
    );
}
