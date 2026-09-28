import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";

/** Settings → Voice Lab: the optional singing engine (server/voicelab.py)
 *  and the singing voice profiles it trains from the user's own recordings.
 *
 *  The engine is a separate download (~12 GB with its models) kept under
 *  the data folder; profiles are RVC voice models trained on audio the user
 *  uploads (their own voice, a voice actor they have permission for …).
 *  A companion picks its profile in the voice view's Stage panel. */
export default function VoiceLabSettings() {
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState("");
    const [draft, setDraft] = useState({ name: "", epochs: 200 });
    const fileRef = useRef(null);
    const retrainRef = useRef(null);
    const [retrainId, setRetrainId] = useState(null);

    const load = async () => {
        try { setData(await rpc("/api/voicelab/status", {})); }
        catch (e) { notification.add(e.message, { type: "danger" }); }
    };
    useEffect(() => { load(); }, []);
    // Poll while something is installing or training.
    const active = data && (data.status.install?.state === "running" || data.profiles.some((p) => p.status === "training"));
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(load, 3000);
        return () => clearInterval(id);
    }, [active]);

    const run = async (label, fn) => {
        setBusy(label);
        try { const r = await fn(); if (r?.status) setData(r); }
        catch (e) { notification.add(e.message, { type: "danger" }); }
        finally { setBusy(""); }
    };

    const upload = async (url, form) => {
        const resp = await fetch(url, { method: "POST", body: form });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body?.error?.message || body?.error || body?.detail || _t("Upload failed."));
        return body;
    };

    const createProfile = (files) => run("create", async () => {
        if (!files?.length) return null;
        const form = new FormData();
        form.append("name", draft.name || _t("Voice"));
        form.append("epochs", String(draft.epochs || 200));
        for (const f of files) form.append("files", f);
        const r = await upload("/api/voicelab/profiles/create", form);
        setDraft({ name: "", epochs: 200 });
        if (fileRef.current) fileRef.current.value = "";
        return r;
    });

    const retrain = (files, id = retrainId) => run("retrain", async () => {
        const form = new FormData();
        form.append("id", String(id));
        for (const f of files || []) form.append("files", f);
        const r = await upload("/api/voicelab/profiles/retrain", form);
        if (retrainRef.current) retrainRef.current.value = "";
        return r;
    });

    if (!data) return null;
    const st = data.status;
    const inst = st.install;

    return (
        <section>
            <h3><i className="fa fa-microphone" /> {_t("Voice Lab (singing voices)")}</h3>
            <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                {_t("An optional engine for the karaoke stage. It trains a singing voice from recordings you upload, so a companion sings in that voice, and it turns songs from links or videos into karaoke: the music, the original singer's vocal (which the voice re-sings) and the lyrics. It runs on your own computer; an NVIDIA graphics card makes it fast.")}
            </p>
            {!st.installed && (
                <div className="rx_row">
                    <div>
                        <button className="btn btn-primary" disabled={inst?.state === "running" || !!busy}
                                onClick={() => run("install", () => rpc("/api/voicelab/install", {}))}>
                            <i className={inst?.state === "running" ? "fa fa-spinner fa-spin" : "fa fa-download"} /> {_t("Install the Voice Lab")}
                        </button>
                    </div>
                    <p className="text-muted small" style={{ margin: 0, alignSelf: "center" }}>
                        {_t("About %s GB download and disk space, kept in the app's data folder.", st.size_gb)}{" "}
                        {st.gpu ? _t("NVIDIA graphics card found: it installs the fast (CUDA) version.")
                            : _t("No NVIDIA graphics card found: it installs the CPU version, which works but trains voices very slowly.")}
                    </p>
                </div>
            )}
            {inst?.state === "running" && <p className="small"><i className="fa fa-spinner fa-spin" /> {inst.stage}</p>}
            {inst?.state === "error" && <p className="small text-danger">{inst.error}</p>}
            {st.installed && (
                <div className="rx_row" style={{ alignItems: "center" }}>
                    <span className="small">
                        {st.running
                            ? <><i className="fa fa-circle text-success" /> {_t("Running on %s", st.health?.device || "…")}</>
                            : <><i className="fa fa-circle-o" /> {_t("Installed; starts by itself when needed")}</>}
                    </span>
                    {!st.running && (
                        <button className="btn btn-light btn-sm" disabled={!!busy}
                                onClick={() => run("start", () => rpc("/api/voicelab/start", {}))}>
                            <i className={busy === "start" ? "fa fa-spinner fa-spin" : "fa fa-play"} /> {_t("Start")}
                        </button>
                    )}
                    {st.running && (
                        <button className="btn btn-light btn-sm" disabled={!!busy}
                                onClick={() => run("stop", () => rpc("/api/voicelab/stop", {}))}>
                            <i className="fa fa-stop" /> {_t("Stop")}
                        </button>
                    )}
                    <button className="btn btn-light btn-sm" disabled={!!busy}
                            title={_t("Delete the engine and its models from the data folder. Voice profiles need it to sing.")}
                            onClick={async () => {
                                if (!(await confirmAsk(_t("Remove the Voice Lab? Its engine, models and trained voices are deleted; companions go back to the built-in singing.")))) return;
                                run("remove", () => rpc("/api/voicelab/uninstall", {}));
                            }}>
                        <i className="fa fa-trash" /> {_t("Remove")}
                    </button>
                </div>
            )}

            {st.installed && (
                <>
                    <h4 style={{ marginTop: "0.75rem" }}>{_t("Singing voice profiles")}</h4>
                    <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                        {_t("Upload clean recordings of one voice (speech or singing, no music or other voices), ideally 10 to 30 minutes in total; singing in the mix helps the high notes. Only use a voice you have the right to use. Training runs in the background: about 18 seconds per round (epoch) for 5 minutes of audio on an RTX 3070, so a 20-minute voice at 200 rounds takes about 4 hours. The best checkpoint is picked by how clearly it still says the words.")}
                    </p>
                    {data.profiles.map((p) => (
                        <div key={p.id} className="rx_voicelab_profile">
                            <div className="rx_row" style={{ alignItems: "center" }}>
                                <strong style={{ flex: 1 }}>{p.name}</strong>
                                <span className="small text-muted">
                                    {p.status === "ready" && _t("Ready · %s min of audio · epoch %s", p.minutes ?? "?", p.chosen_epoch ?? "?")}
                                    {p.status === "training" && <><i className="fa fa-spinner fa-spin" /> {p.stage || _t("Training")} ({Math.round((p.progress || 0) * 100)}%)</>}
                                    {p.status === "stopped" && _t("Stopped at %s when the app closed · ↻ carries on", `${Math.round((p.progress || 0) * 100)}%`)}
                                    {p.status === "error" && <span className="text-danger">{p.error}</span>}
                                </span>
                                <button className="btn btn-light btn-sm" disabled={p.status === "training" || !!busy}
                                        title={p.status === "stopped" || p.status === "error"
                                            ? _t("Carry on training from the last checkpoint")
                                            : _t("Train again from the start, on the recordings it has")}
                                        onClick={() => { setRetrainId(p.id); retrain([], p.id); }}>
                                    <i className="fa fa-refresh" />
                                </button>
                                <button className="btn btn-light btn-sm" disabled={p.status === "training" || !!busy}
                                        title={_t("Add more recordings and train again")}
                                        onClick={() => { setRetrainId(p.id); retrainRef.current?.click(); }}>
                                    <i className="fa fa-plus" />
                                </button>
                                <button className="btn btn-light btn-sm" disabled={p.status === "training" || !!busy}
                                        title={_t("Delete this voice")}
                                        onClick={async () => {
                                            if (!(await confirmAsk(_t("Delete the voice '%s'? Songs it sang are forgotten too.", p.name)))) return;
                                            run("delete", () => rpc("/api/voicelab/profiles/delete", { id: p.id }));
                                        }}>
                                    <i className="fa fa-trash" />
                                </button>
                            </div>
                            {p.scores?.length > 0 && (
                                <div className="small text-muted">
                                    {_t("Word errors by checkpoint:")} {p.scores.map((s) => `${s.epoch}: ${Math.round(s.wer * 100)}%`).join(" · ")}
                                </div>
                            )}
                        </div>
                    ))}
                    <input ref={retrainRef} type="file" multiple hidden accept="audio/*,video/*"
                           onChange={(e) => retrain([...e.target.files])}
                           onClick={(e) => { e.target.value = ""; }} />
                    <div className="rx_row" style={{ marginTop: "0.5rem" }}>
                        <div style={{ flex: 2 }}>
                            <label>{_t("New voice name")}</label>
                            <input type="text" value={draft.name} placeholder={_t("e.g. Eve")}
                                   onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        </div>
                        <div>
                            <label title={_t("More rounds learn the voice more closely and take longer. The RVC project suggests 200 for clean recordings, and 20 to 30 for noisy ones.")}>{_t("Epochs")}</label>
                            <input type="number" min={50} max={1000} step={25} value={draft.epochs}
                                   onChange={(e) => setDraft({ ...draft, epochs: Number(e.target.value) })} />
                        </div>
                        <div style={{ alignSelf: "flex-end" }}>
                            <button className="btn btn-primary" disabled={!draft.name.trim() || !!busy}
                                    onClick={() => fileRef.current?.click()}>
                                <i className={busy === "create" ? "fa fa-spinner fa-spin" : "fa fa-upload"} /> {_t("Choose recordings and train")}
                            </button>
                            <input ref={fileRef} type="file" multiple hidden accept="audio/*,video/*"
                                   onChange={(e) => createProfile([...e.target.files])} />
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}
