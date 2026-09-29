import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";

/** Settings → Extensions (server/plugins.py).
 *
 *  Lists every extension found, with its load error if any, and stores which
 *  to skip plus extra folders to search. Saves straight away, outside the
 *  page's Save bar: none of it applies before the next start anyway.
 */
export default function ExtensionsSettings() {
    const [data, setData] = useState(null);
    const [dirsText, setDirsText] = useState("");
    const [changed, setChanged] = useState(false);   // saved since this start: needs a restart

    const apply = (res) => {
        setData(res);
        setDirsText((res.dirs || []).join("\n"));
    };

    useEffect(() => {
        rpc("/api/extensions/list", {}).then(apply).catch(() => {});
    }, []);

    if (!data) return null;

    const disabled = data.extensions.filter((x) => !x.enabled).map((x) => x.id);

    const save = async (nextDisabled, dirs) => {
        try {
            apply(await rpc("/api/extensions/save", { disabled: nextDisabled, dirs }));
            setChanged(true);
        } catch (e) {
            notification.add(e.message || String(e), { type: "danger" });
        }
    };

    const toggle = (ext) => save(
        ext.enabled ? [...disabled, ext.id] : disabled.filter((id) => id !== ext.id),
        data.dirs);

    const dirsDirty = dirsText.split("\n").map((s) => s.trim()).filter(Boolean).join("\n")
        !== (data.dirs || []).join("\n");

    return (
        <section>
            <h3><i className="fa fa-puzzle-piece" /> {_t("Extensions")}</h3>
            <p className="text-muted">
                {_t("Add-ons that live outside the app: each is a folder with a plugin.json. "
                    + "Put them in %s, or list other folders below. Extensions load when "
                    + "Rexclaw starts, so changes here apply after a restart. Only install "
                    + "extensions you trust: they run with the same access as the app.",
                    data.default_dir)}
            </p>
            {!data.extensions.length && (
                <p className="text-muted small">{_t("No extensions found.")}</p>
            )}
            {data.extensions.map((ext) => (
                <div key={ext.id} className="rx_row" style={{ alignItems: "center" }}>
                    <div>
                        <strong>{ext.name}</strong>
                        {ext.version && <span className="text-muted small"> v{ext.version}</span>}
                        {ext.description && <div className="text-muted small">{ext.description}</div>}
                        <div className="text-muted small" title={ext.path}>
                            {ext.error
                                ? "❌ " + ext.error
                                : ext.loaded
                                    ? (ext.enabled ? "✅ " + _t("Running") : _t("Turns off after a restart"))
                                    : (ext.enabled ? _t("Loads after a restart") : _t("Off"))}
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                        {ext.loaded && ext.page && (
                            <button className="btn btn-light"
                                    onClick={() => window.open(new URL(ext.page, window.location.href).href,
                                                               `rexclaw-ext-${ext.id}`)}>
                                <i className="fa fa-external-link" /> {_t("Open")}
                            </button>
                        )}
                        <button className={"btn " + (ext.enabled ? "btn-primary" : "btn-light")}
                                onClick={() => toggle(ext)}>
                            {ext.enabled ? _t("On") : _t("Off")}
                        </button>
                    </div>
                </div>
            ))}
            <div className="rx_row">
                <div>
                    <label>{_t("Extra extension folders (one per line)")}</label>
                    <textarea rows={2} value={dirsText}
                              placeholder={_t("e.g. C:\\Users\\me\\my-extensions")}
                              onChange={(ev) => setDirsText(ev.target.value)} />
                </div>
                <div style={{ alignSelf: "end" }}>
                    <button className="btn btn-light" disabled={!dirsDirty}
                            onClick={() => save(disabled, dirsText.split("\n"))}>
                        {_t("Save folders")}
                    </button>
                </div>
            </div>
            {changed && (
                <p className="text-muted small">{_t("Restart Rexclaw to apply the changes.")}</p>
            )}
        </section>
    );
}
