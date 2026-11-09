import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";

/** Settings → Decision model → Local model: the optional downloads
 *  (server/decision_local.py). Valen-Decision in four sizes with their own
 *  Python environment, kept under the data folder; the one picked here is kept
 *  loaded while "Local model" is the chosen decision model.
 *  `model` / `onModel` and `device` / `onDevice` are the form's
 *  decision_local_model and decision_local_device ("" = pick for me);
 *  `saved` changes with every Settings save, which is what loads or
 *  unloads the model. */
export default function DecisionLocalSettings({ model, onModel, device, onDevice, saved }) {
    const [st, setSt] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = async () => {
        try { setSt(await rpc("/api/decision_local/status", {})); }
        catch (e) { notification.add(e.message, { type: "danger" }); }
    };
    useEffect(() => { load(); }, [saved]);
    // Poll while it installs, and while it loads after a start.
    const active = st && (st.install?.state === "running" || (st.running && !st.up));
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(load, 3000);
        return () => clearInterval(id);
    }, [active]);

    const run = async (fn) => {
        setBusy(true);
        try { setSt(await fn()); }
        catch (e) { notification.add(e.message, { type: "danger" }); }
        finally { setBusy(false); }
    };

    if (!st) return null;
    const inst = st.install;
    const installing = inst?.state === "running";
    const picked = st.models.find((m) => m.key === model) || st.models[0];
    return (
        <>
            <p className="text-muted small" style={{ margin: "0 0 0.5rem" }}>
                {_t("Valen-Decision is an open decision model that runs on your own computer, so nothing it reads leaves it and nothing is billed. Like Jev it finds things on a screenshot. Each size is a separate download, kept in the app's data folder; pick the one your computer can hold (the larger ones judge better).")}{" "}
                {st.gpu ? _t("Your graphics card has %s GB of video memory.", st.vram_gb)
                    : _t("No NVIDIA graphics card found.")}
            </p>
            {st.models.map((m) => (
                <div key={m.key} className="rx_row" style={{ alignItems: "center" }}>
                    <div className="rx_check" style={{ flex: 2, margin: 0 }}>
                        <input id={`rx_dm_${m.key}`} type="radio" name="rx_decision_local_model"
                               checked={picked.key === m.key} onChange={() => onModel(m.key)} />
                        <label htmlFor={`rx_dm_${m.key}`}>
                            {m.name} <span className="text-muted">
                                · {_t("%s GB", m.size_gb)}
                                {" · "}{_t("needs a %s GB graphics card", m.needs_gb)}
                                {" · "}{m.fits ? _t("fits yours") : _t("too big for yours")}
                            </span>
                        </label>
                    </div>
                    <div>
                        {m.installed ? (
                            <button className="btn btn-light btn-sm" disabled={busy || installing}
                                    title={_t("Delete this model from the data folder.")}
                                    onClick={async () => {
                                        if (!(await confirmAsk(_t("Remove %s? Its files are deleted from the data folder.", m.name)))) return;
                                        run(() => rpc("/api/decision_local/uninstall", { model: m.key }));
                                    }}>
                                <i className="fa fa-trash" /> {_t("Remove")}
                            </button>
                        ) : (
                            <button className="btn btn-light btn-sm" disabled={busy || installing}
                                    title={_t("About %s GB to download.", m.download_gb)}
                                    onClick={() => run(() => rpc("/api/decision_local/install", { model: m.key }))}>
                                <i className={installing && inst.model === m.key ? "fa fa-spinner fa-spin" : "fa fa-download"} /> {_t("Download")}
                            </button>
                        )}
                    </div>
                </div>
            ))}
            {installing && (
                <p className="small">
                    <i className="fa fa-spinner fa-spin" /> {inst.stage}
                    {inst.progress != null && ` (${Math.round(inst.progress * 100)}%)`}
                </p>
            )}
            {inst?.state === "error" && <p className="small text-danger">{inst.error}</p>}
            <p className="text-muted small">
                {_t("The app and Windows use video memory too, so a model needs a card that holds both. One that doesn't fit answers in minutes instead of tenths of a second, on the graphics card or on the processor, and the features that ask it get nothing.")}
            </p>
            {picked.installed && (
                <div className="rx_row" style={{ alignItems: "center" }}>
                    <span className="small">
                        {st.up && st.model === picked.key
                            ? <><i className="fa fa-circle text-success" /> {_t("Running on %s", st.device === "cuda" ? _t("the graphics card") : _t("the processor"))}</>
                            : st.running && st.model === picked.key
                                ? <><i className="fa fa-spinner fa-spin" /> {_t("Loading the model…")}</>
                                : <><i className="fa fa-circle-o" /> {_t("Downloaded; loads when Settings are saved with it picked")}</>}
                    </span>
                    <div>
                        <select value={device || ""} style={{ width: "auto" }}
                                title={_t("Where the model runs. Automatic uses the graphics card when it holds the model beside the app.")}
                                onChange={(ev) => onDevice(ev.target.value)}>
                            <option value="">{_t("Automatic")}</option>
                            <option value="cuda">{_t("Graphics card")}</option>
                            <option value="cpu">{_t("Processor")}</option>
                        </select>
                    </div>
                </div>
            )}
        </>
    );
}
