import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { services } from "../services";
import { neuralMotion } from "../services/neural_motion/neural_motion_service";

const PARTS = [
    ["torso", "Torso"],
    ["head", "Head"],
    ["arms", "Arms"],
    ["hands", "Fingers"],
    ["legs", "Hips + legs"],
    ["footik", "Foot IK"],
    ["shuffle", "Shuffling"],
];

/** Applies the call config to the avatar on this page. */
function applyHere(call) {
    neuralMotion.configure(call);
    services.motion_director?.setNeuralMotion?.(!!call);
}

/** Neural body motion settings: in the voice view's Settings, beside the
 *  avatar so a style can be judged as it plays, and in the mascot settings
 *  window (`apply` hands the call config to the overlay, which has the
 *  avatar; no test file there). `agentId` is the companion on screen: a
 *  switch to another one takes their avatar's defaults first. Models are
 *  folders under server/neural_motion/models/; one that is missing its
 *  weights still lists, marked, so the folder it wants is on screen. */
export default function NeuralMotionSection({ agentId = null, apply = applyHere, testable = true }) {
    const [models, setModels] = useState([]);
    const [saved, setSaved] = useState(null);
    const [playing, setPlaying] = useState(false);
    const fileInput = useRef(null);

    useEffect(() => {
        rpc("/api/neural_motion/settings", agentId ? { agent_id: agentId } : {}).then(({ models, settings, call, switched }) => {
            setModels(models);
            setSaved(settings);
            if (switched) apply(call);
        }).catch((e) => notification.add(e.message, { type: "danger" }));
    }, [agentId]);

    useEffect(() => () => neuralMotion.stopTest(), []);

    if (!saved || !models.length) return null;
    const model = models.find((m) => m.id === saved.model) || models[0];
    const style = saved.style >= 0 ? saved.style : model.default_style;
    const parts = saved.parts;

    const patch = async (changes) => {
        const { settings, call } = await rpc("/api/neural_motion/settings", changes);
        setSaved(settings);
        // A running call picks this up at once, from its next line.
        apply(call);
    };

    const test = async (file) => {
        if (!file) return;
        neuralMotion.configure({ model: model.id, style, parts });
        setPlaying(true);
        try {
            await neuralMotion.testFile(file);
        } catch (e) {
            notification.add(e.message, { type: "danger" });
        }
        setPlaying(false);
        console.info("[neural motion]", neuralMotion.stats());
        if (!saved.on) neuralMotion.configure(null);
    };

    return (
        <div className="o_voice_full_settings_section">
            <strong>{_t("Neural body motion")}</strong>
            <div className="o_voice_full_settings_row">
                <label htmlFor="rx_nm_model">{_t("Model")}</label>
                <select id="rx_nm_model" value={model.id}
                        onChange={(ev) => patch({ model: ev.target.value })}>
                    {models.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.label}{m.ready ? "" : ` (${_t("no weights")})`}
                        </option>
                    ))}
                </select>
            </div>
            {!model.ready && <div className="text-muted small">{_t("Weights go in %s", model.folder)}</div>}
            {model.ready && <>
                <div className="o_voice_full_settings_row">
                    <label htmlFor="rx_nm_on">{_t("Use in calls (replaces clip gestures)")}</label>
                    <input id="rx_nm_on" type="checkbox" checked={!!saved.on}
                           onChange={(ev) => patch({ on: ev.target.checked, model: model.id })} />
                </div>
                {!!model.styles.length && (
                    <div className="o_voice_full_settings_row">
                        <label htmlFor="rx_nm_style">{_t("Style")}</label>
                        <select id="rx_nm_style" value={style}
                                onChange={(ev) => patch({ style: Number(ev.target.value) })}>
                            {model.styles.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                    </div>
                )}
                <div className="rx_nm_parts">
                    {PARTS.map(([id, label]) => (
                        <label key={id} htmlFor={`rx_nm_${id}`}>
                            <input id={`rx_nm_${id}`} type="checkbox" checked={parts.includes(id)}
                                   onChange={(ev) => patch({
                                       parts: ev.target.checked ? [...parts, id] : parts.filter((p) => p !== id),
                                   })} />
                            {_t(label)}
                        </label>
                    ))}
                </div>
                {testable && (
                    <div className="o_voice_full_settings_row">
                        <input ref={fileInput} type="file" accept="audio/*" hidden
                               onChange={(ev) => { test(ev.target.files[0]); ev.target.value = ""; }} />
                        {playing
                            ? <button className="btn btn-secondary btn-sm"
                                      onClick={() => neuralMotion.stopTest()}>{_t("Stop")}</button>
                            : <button className="btn btn-secondary btn-sm"
                                      onClick={() => fileInput.current.click()}>{_t("Test with a speech file")}</button>}
                    </div>
                )}
            </>}
        </div>
    );
}
