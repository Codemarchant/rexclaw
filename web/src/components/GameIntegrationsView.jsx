import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";

/** Game integrations: game sidecars a companion can inhabit as a real
 *  player. Minecraft is the first; the tab gives each integration its own
 *  home instead of crowding Settings, and future games slot in as new
 *  sections here. Saves only its own fields (config/set accepts partial
 *  payloads), so it can't clobber unsaved edits on the Settings tab. */
export default function GameIntegrationsView({ active }) {
    const [config, setConfig] = useState(null);
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            setConfig(await rpc("/api/config/get", {}));
        } catch (e) {
            notification.add(e?.message || _t("Could not load settings"), { type: "danger" });
        }
    };
    useEffect(() => {
        if (active) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const setField = (key, value) => setConfig((c) => ({ ...c, [key]: value }));

    const save = async () => {
        setSaving(true);
        try {
            await rpc("/api/config/set", {
                minecraft_brain_model: config.minecraft_brain_model || "",
                minecraft_brain_model_hard: config.minecraft_brain_model_hard || "",
                minecraft_master: config.minecraft_master || "",
            });
            notification.add(_t("Settings saved."), { type: "info" });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
        } finally {
            setSaving(false);
        }
    };

    if (!config) {
        return <div className="rx_settings"><div className="rx_settings_inner">{_t("Loading…")}</div></div>;
    }

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-cube" /> {_t("Minecraft bot")}</h3>
                    <p className="text-muted">
                        {_t("Companions with \"Minecraft bot\" enabled (per companion, "
                            + "on the Companions tab) can direct a bot that joins your "
                            + "Minecraft world as its own player and plays for real: "
                            + "mining, crafting, building, following you. You give "
                            + "orders by voice, and your companion reacts to what "
                            + "happens in the world. Each command is planned by the "
                            + "cheaper standard model below; for big jobs (long "
                            + "multi-stage tasks, elaborate builds) your companion "
                            + "can forward a command to the hard-task model instead, "
                            + "which thinks much longer before acting. The bot "
                            + "executes model-generated scripts in your world, so "
                            + "use it on your own or trusted servers only.")}
                    </p>
                    <p className="text-muted">
                        {_t("Setup: start your world and open it to LAN (Minecraft "
                            + "prints a new port every time), then run the sidecar "
                            + "on the same machine as the game (first time: npm "
                            + "install). Set --username to your companion's name so "
                            + "the character in the world is them, not a stranger:")}
                        <br />
                        <code>cd rexclaw\game_integrations\minecraft</code><br />
                        <code>node index.js --port 65000 --username Ara</code>
                    </p>
                    <p className="text-muted">
                        {_t("Requirements: Node 18+, and a Minecraft Java Edition "
                            + "world on a version mineflayer supports (currently up "
                            + "to 1.21.11).")}
                    </p>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Bot brain model (empty = grok-4.20-non-reasoning)")}</label>
                            <input type="text"
                                   placeholder="grok-4.20-non-reasoning"
                                   value={config.minecraft_brain_model || ""}
                                   onChange={(ev) => setField("minecraft_brain_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Hard-task model for big jobs (empty = disabled)")}</label>
                            <input type="text"
                                   placeholder="grok-4.5"
                                   value={config.minecraft_brain_model_hard || ""}
                                   onChange={(ev) => setField("minecraft_brain_model_hard", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Your in-game username (the bot prioritizes you)")}</label>
                            <input type="text"
                                   placeholder={_t("e.g. Jonny")}
                                   value={config.minecraft_master || ""}
                                   onChange={(ev) => setField("minecraft_master", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Sidecar")}</label>
                            <div className="rx_wake_status">
                                {config.minecraft_connected
                                    ? "✅ " + _t("Connected — the tool is live in new calls")
                                    : "❌ " + _t("Not connected — start it with node index.js "
                                        + "in the game_integrations/minecraft folder, "
                                        + "then reopen this tab")}
                            </div>
                        </div>
                    </div>
                </section>

                <section>
                    <button className="btn btn-primary" disabled={saving} onClick={save}>
                        <i className="fa fa-save" /> {_t("Save settings")}
                    </button>
                </section>
            </div>
        </div>
    );
}
