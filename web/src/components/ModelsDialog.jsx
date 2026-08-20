import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";

const KIND_LABELS = {
    voice: "Voice models",
    language: "Text models",
    image: "Image models",
    video: "Video models",
};

/** "See all models": read-only list of every model the xAI key can reach,
 *  grouped by kind. Deliberately not a picker — plenty of listed models
 *  don't suit a given field (coding / reasoning-only models reject the
 *  parameters text mode sends), so the choice stays a typed one. */
export default function ModelsDialog({ apiKey, onClose }) {
    const [groups, setGroups] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        rpc("/api/xai/models", { api_key: apiKey || undefined })
            .then((res) => { if (alive) setGroups(res.groups || []); })
            .catch((e) => { if (alive) setError(e?.message || _t("Could not load models.")); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className="rx_dialog rx_dialog--models" role="dialog" aria-modal="true"
                 onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Available models")}</h4>
                <p>
                    {_t("Every model your key can reach, grouped by kind. Type the id "
                        + "you want into the matching field above — not every model suits "
                        + "every field (e.g. coding or reasoning-only models won't work as "
                        + "the text model).")}
                </p>
                <div className="rx_models_body">
                    {!groups && !error && <div className="rx_models_msg">{_t("Loading…")}</div>}
                    {error && <div className="rx_models_msg is-error">{error}</div>}
                    {groups && groups.map((g) => (
                        <div className="rx_models_group" key={g.kind}>
                            <h5>{_t(KIND_LABELS[g.kind] || g.kind)}</h5>
                            {g.error && <div className="rx_models_msg is-error">{g.error}</div>}
                            {!g.error && g.models.length === 0 && (
                                <div className="rx_models_msg">{_t("None returned for your key.")}</div>
                            )}
                            {g.models.length > 0 && (
                                <ul>
                                    {g.models.map((m) => (
                                        <li key={m.id}>
                                            <span className="rx_model_id">{m.id}</span>
                                            {m.aliases.length > 0 && (
                                                <span className="rx_model_alias">
                                                    {_t("alias")}: {m.aliases.join(", ")}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
                <div className="rx_dialog_actions">
                    <button className="btn btn-secondary" onClick={onClose}>{_t("Close")}</button>
                </div>
            </div>
        </div>
    );
}
