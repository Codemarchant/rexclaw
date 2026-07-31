import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t, i18nState, setLocale, LOCALES } from "../lib/i18n";

/** Settings: global app configuration — BYOK key + models, user identity and
 *  context-management thresholds. Companions and avatar packs have their own
 *  tabs (CompanionsView / AvatarsView); stored memories live on Memories. */
export default function SettingsView({ active }) {
    const [config, setConfig] = useState(null);
    const [apiKeyDraft, setApiKeyDraft] = useState("");
    const [agents, setAgents] = useState([]);
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            const [cfg, ags] = await Promise.all([
                rpc("/api/config/get", {}),
                rpc("/api/agents/list", {}),
            ]);
            setConfig(cfg);
            setAgents(ags);
        } catch (e) {
            notification.add(e?.message || _t("Could not load settings"), { type: "danger" });
        }
    };

    useEffect(() => {
        if (active) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    if (!config) {
        return <div className="rx_settings"><div className="rx_settings_inner">{_t("Loading…")}</div></div>;
    }

    const setField = (key, value) => setConfig((c) => ({ ...c, [key]: value }));

    const saveConfig = async () => {
        setSaving(true);
        try {
            const payload = { ...config };
            delete payload.has_api_key;
            delete payload.api_key_hint;
            delete payload.spend_today_usd;
            delete payload.spend_lifetime_usd;
            if (apiKeyDraft.trim()) payload.xai_api_key = apiKeyDraft.trim();
            await rpc("/api/config/set", payload);
            setApiKeyDraft("");
            notification.add(_t("Settings saved."), { type: "info" });
            load();
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <section>
                    <h3><i className="fa fa-key" /> {_t("xAI connection")}</h3>
                    <label>{_t("API key")} {config.has_api_key && <span className="text-muted">({_t("saved")} {config.api_key_hint || ""})</span>}</label>
                    <input
                        type="password"
                        placeholder={config.has_api_key ? _t("•••••••• (leave blank to keep current key)") : "xai-…"}
                        value={apiKeyDraft}
                        onChange={(ev) => setApiKeyDraft(ev.target.value)}
                    />
                    <div className="rx_row">
                        <div>
                            <label>{_t("Voice model")}</label>
                            <input type="text" value={config.xai_model || ""}
                                   onChange={(ev) => setField("xai_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Text model")}</label>
                            <input type="text" value={config.text_model || ""}
                                   onChange={(ev) => setField("text_model", ev.target.value)} />
                        </div>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Summary model")}</label>
                            <input type="text" value={config.summary_model || ""}
                                   onChange={(ev) => setField("summary_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Imagine model")}</label>
                            <input type="text" value={config.imagine_model || ""}
                                   onChange={(ev) => setField("imagine_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("Grok Imagine video model for animated backgrounds and create_video. Priced per second of video. grok-imagine-video (default) supports reference-to-video — the selfie/reference_images flow; grok-imagine-video-1.5 adds 1080p image-to-video but does NOT support reference-to-video.")}>
                                {_t("Imagine video model")}
                            </label>
                            <input type="text" value={config.imagine_video_model || ""}
                                   placeholder="grok-imagine-video"
                                   onChange={(ev) => setField("imagine_video_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("Model for the group-call turn director (a one-token \"who speaks next\" classification on every group-call turn). Latency matters more than intelligence here — use the fastest non-reasoning model available. Empty = fall back to the Text Model.")}>
                                {_t("Turn director model")}
                            </label>
                            <input type="text" value={config.director_model || ""}
                                   placeholder="grok-4.20-non-reasoning"
                                   onChange={(ev) => setField("director_model", ev.target.value)} />
                        </div>
                    </div>
                    <div className="rx_row">
                        <div>
                            <label title={_t("xAI multi-agent model used when delegate_task is called with multi_agent=true. Several agents collaborate on the query and a leader synthesizes — every sub-agent bills tokens, so this is markedly more expensive than a standard call. Beta on xAI's side; custom function tools are NOT supported there.")}>
                                {_t("Multi-agent model")}
                            </label>
                            <input type="text" value={config.multi_agent_model || ""}
                                   placeholder="grok-4.20-multi-agent"
                                   onChange={(ev) => setField("multi_agent_model", ev.target.value)} />
                        </div>
                        <div>
                            <label title={_t("reasoning.effort sent on multi-agent delegations — xAI maps low/medium to 4 collaborating agents, high/xhigh to 16.")}>
                                {_t("Multi-agent effort")}
                            </label>
                            <select value={config.multi_agent_effort || "low"}
                                    onChange={(ev) => setField("multi_agent_effort", ev.target.value)}>
                                <option value="low">{_t("Low (4 agents)")}</option>
                                <option value="medium">{_t("Medium (4 agents)")}</option>
                                <option value="high">{_t("High (16 agents)")}</option>
                                <option value="xhigh">{_t("X-High (16 agents)")}</option>
                            </select>
                        </div>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-user" /> {_t("You")}</h3>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Display name (optional)")}</label>
                            <input type="text" value={config.user_display_name || ""}
                                   onChange={(ev) => setField("user_display_name", ev.target.value)} />
                        </div>
                        <div>
                            <label>{_t("Default companion")}</label>
                            <select value={config.default_agent_id ?? ""}
                                    onChange={(ev) => setField("default_agent_id", parseInt(ev.target.value, 10) || null)}>
                                {agents.map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label>{_t("Language")}</label>
                            <select value={i18nState.locale}
                                    onChange={(ev) => setLocale(ev.target.value)}
                                    title={_t("UI language — stored in this browser. Companions follow the language you speak regardless.")}>
                                {LOCALES.map(([id, label]) => (
                                    <option key={id} value={id}>{label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="rx_check">
                        <input id="rx_include_name" type="checkbox"
                               checked={!!config.include_user_name_in_prompt}
                               onChange={(ev) => setField("include_user_name_in_prompt", ev.target.checked ? 1 : 0)} />
                        <label htmlFor="rx_include_name">
                            {_t("Include my name in the system prompt (sent to xAI — off by default)")}
                        </label>
                    </div>
                </section>

                <section>
                    <h3><i className="fa fa-compress" /> {_t("Context management")}</h3>
                    <div className="rx_row">
                        <div>
                            <label>{_t("Voice summarization threshold (tokens)")}</label>
                            <input type="number" value={config.summary_threshold_tokens ?? 0}
                                   onChange={(ev) => setField("summary_threshold_tokens", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                        <div>
                            <label>{_t("Text summarization threshold (tokens)")}</label>
                            <input type="number" value={config.summary_threshold_tokens_text ?? 0}
                                   onChange={(ev) => setField("summary_threshold_tokens_text", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                        <div>
                            <label>{_t("Recent turns kept verbatim")}</label>
                            <input type="number" value={config.summary_keep_recent_messages ?? 2}
                                   onChange={(ev) => setField("summary_keep_recent_messages", parseInt(ev.target.value, 10) || 0)} />
                        </div>
                    </div>
                </section>

                <section>
                    <button className="btn btn-primary" disabled={saving} onClick={saveConfig}>
                        <i className="fa fa-save" /> {_t("Save settings")}
                    </button>
                </section>
            </div>
        </div>
    );
}
