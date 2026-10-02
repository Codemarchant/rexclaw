import React, { useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";

// Stage order and headings. Engines, connection kinds and every field come
// from the server (server/pipeline/engines.py catalog) — an extension's
// engine shows up here with its own settings, no UI change needed.
const STAGES = [
    ["stt", "fa-microphone", "Speech to text"],
    ["llm", "fa-comments", "Brain"],
    ["tts", "fa-volume-up", "Voice"],
];

// "Add connection" shortcuts: the usual servers at their usual addresses.
// `serves`: the stages that server offers, which tick the connection's
// "Offers …" boxes (engines.SERVES) — a setup lists a connection only under
// those. `defaults`: that service's own model and voice names, used when a
// stage picks a connection at its address, in place of the engine's
// (Kokoro's, Whisper's). Sources, 2026-10-01:
//   Groq       console.groq.com/docs/speech-to-text (whisper-large-v3-turbo).
//               Its voice (Orpheus) takes at most 200 characters a request,
//               less than a long sentence, so it starts unticked.
//   OpenRouter  openrouter.ai/docs → multimodal/stt (OpenAI-style uploads work;
//               models by OpenRouter's names, e.g. openai/whisper-large-v3-turbo).
//               Its voice endpoint answers only in mp3 or pcm, not the wav
//               this engine asks for by default, so it starts unticked.
//               google/gemini-3.8-flash: images + tools, $0.75 / $3.75 per M
//               (openrouter.ai/api/v1/models, 2026-10-02).
//   DeepSeek    api-docs.deepseek.com (2026-10-02): deepseek-flash = V4.1-Flash
//               (vision, tools, 1M context; $0.30 / $1.20 per M peak, half
//               off-peak). Thinking is on by default and, with tools, wants
//               every earlier turn's reasoning sent back (a 400 otherwise),
//               which saved conversations don't keep - so reasoning "none".
//   Kokoro      remsky/Kokoro-FastAPI: streamed wav carries placeholder sizes,
//               raw pcm is 24 kHz 16-bit mono and starts sooner.
const PRESETS = [
    { label: "Ollama", kind: "openai", url: "http://127.0.0.1:11434/v1", serves: ["llm"] },
    { label: "LM Studio", kind: "openai", url: "http://127.0.0.1:1234/v1", serves: ["llm"] },
    { label: "speaches", kind: "openai", url: "http://127.0.0.1:8000/v1", serves: ["stt", "tts"] },
    { label: "Kokoro-FastAPI", kind: "openai", url: "http://127.0.0.1:8880/v1", serves: ["tts"],
      defaults: { tts: { response_format: "pcm", sample_rate: 24000 } } },
    // OpenAI's own API is a connection kind of its own (engine defaults:
    // gpt-transcribe, gpt-6.1-sol / gpt-6-luna, gpt-4o-mini-tts + marin).
    { label: "OpenAI", kind: "openai_cloud", url: "https://api.openai.com/v1" },
    { label: "Groq", kind: "openai", url: "https://api.groq.com/openai/v1", serves: ["stt", "llm"],
      defaults: { stt: { model: "whisper-large-v3-turbo" } } },
    { label: "OpenRouter", kind: "openai", url: "https://openrouter.ai/api/v1", serves: ["stt", "llm"],
      defaults: { stt: { model: "openai/whisper-large-v3-turbo" },
                  llm: { model: "google/gemini-3.8-flash", vision: true } } },
    { label: "DeepSeek", kind: "openai", url: "https://api.deepseek.com", serves: ["llm"],
      defaults: { llm: { model: "deepseek-flash", reasoning_effort: "none", vision: true } } },
    { label: "Anthropic (Claude)", kind: "anthropic", url: "https://api.anthropic.com" },
    { label: "Fish Audio", kind: "fish", url: "" },
    { label: "ElevenLabs", kind: "elevenlabs", url: "" },
];
// The shortcut a connection was made from, by its address (it isn't stored).
const presetFor = (connection) => {
    const url = (connection?.settings?.base_url || "").replace(/\/+$/, "");
    return url ? PRESETS.find((p) => p.url === url) : undefined;
};
// A setup lists a connection under a stage unless its "Offers …" box for
// that stage is unticked.
const serves = (connection, stage) => connection?.settings?.[`serves_${stage}`] !== false;
// The provider-run tools a brain takes (LlmEngine.hosted_for): an
// OpenAI-compatible brain has them only on OpenAI's own API, off Chat
// Completions (llm.OpenAiLlm.hosted_for).
const hostedTools = (engine, connection, stage) => {
    if (engine?.kind !== "openai") return engine?.hosted_tools || [];
    let host = "";
    try { host = new URL(connection?.settings?.base_url || "").hostname; } catch { /* no URL yet */ }
    return host === "api.openai.com" && stage.api !== "chat" ? ["web_search", "code_interpreter", "mcp"] : [];
};

let tempId = 0;
const newId = () => `new:${Date.now()}:${++tempId}`;
const isSaved = (id) => typeof id === "number";

const defaultsOf = (fields) => Object.fromEntries((fields || []).map((f) => [f.key, f.default]));

/** Settings → Models & providers: where engines live (connections) and the named
 *  speech-to-text → brain → voice setups companions pick from.
 *
 *  Controlled, like HotkeysSettings: `connections` and `setups` are the
 *  lists /api/config/get returns (API keys as saved flags), and every edit
 *  goes back through onChange so the page's Save applies it. A key field
 *  holds true (saved), a typed string (replace) or null (remove); the
 *  server keeps a saved key unless it gets one of the last two. New rows
 *  carry a temporary 'new:…' id the server swaps for a real one. */
export default function VoiceSetupsSettings({ connections, setups, defaultSetup, catalog, smartTurnAvailable,
                                              dirty, onChange }) {
    const [tests, setTests] = useState({});
    // Rows start folded so the page stays short; a row you add opens. Keys
    // are "c:<id>" / "s:<id>" — connection and setup ids share numbers.
    const [open, setOpen] = useState(() => new Set());
    if (!connections || !setups || !catalog) return null;

    const toggle = (id) => setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
    });
    const kinds = Object.fromEntries(catalog.kinds.map((k) => [k.kind, k]));
    const engineFor = (stage, kind) => catalog.engines[stage].find((e) => e.kind === kind);
    const connById = (id) => connections.find((c) => String(c.id) === String(id));
    const change = (patch) => onChange({ connections, setups, defaultSetup, ...patch });

    // ---- connections ----
    const addConnection = (label, kind, url, offered) => {
        const fields = defaultsOf(kinds[kind]?.fields);
        if (url) fields.base_url = url;
        for (const [stage] of STAGES) {
            if (offered && `serves_${stage}` in fields) fields[`serves_${stage}`] = offered.includes(stage);
        }
        const id = newId();
        setOpen((prev) => new Set(prev).add(`c:${id}`));
        change({ connections: [...connections, { id, name: label, kind, settings: fields }] });
    };
    const setConnection = (id, patch) => change({
        connections: connections.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
    const removeConnection = (id) => change({
        connections: connections.filter((c) => c.id !== id),
        // Stages that used it fall back to xAI rather than pointing nowhere;
        // a speech-to-speech setup on it goes back to separate stages.
        setups: setups.map((s) => ({
            ...s,
            stages: Object.fromEntries(Object.entries(s.stages).map(([stage, st]) => {
                const uses = st && stage !== "turn" && String(st.connection) === String(id);
                return [stage, !uses ? st : stage === "realtime" ? null : stageFor(stage, "xai")];
            })),
        })),
    });

    // ---- setups ----
    function stageFor(stage, connectionId) {
        const conn = connectionId === "xai" ? null : connById(connectionId);
        return { connection: connectionId, ...defaultsOf(engineFor(stage, conn ? conn.kind : "xai")?.fields),
                 ...presetFor(conn)?.defaults?.[stage] };
    }
    const addSetup = () => {
        const id = newId();
        setOpen((prev) => new Set(prev).add(`s:${id}`));
        change({
            setups: [...setups, {
                id, name: _t("New voice setup"),
                stages: { stt: stageFor("stt", "xai"), llm: stageFor("llm", "xai"), tts: stageFor("tts", "xai"),
                          turn: defaultsOf(catalog.turn) },
            }],
        });
    };
    const setSetup = (id, patch) => change({ setups: setups.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    const setStage = (setup, stage, value) => setSetup(setup.id, { stages: { ...setup.stages, [stage]: value } });
    const removeSetup = (id) => change({
        setups: setups.filter((s) => s.id !== id),
        defaultSetup: String(defaultSetup) === String(id) ? "realtime" : defaultSetup,
    });

    const runTest = async (id) => {
        setTests((t) => ({ ...t, [id]: "busy" }));
        try {
            const result = await rpc("/api/voice/pipeline/test", { setup_id: id });
            setTests((t) => ({ ...t, [id]: result }));
        } catch (e) {
            setTests((t) => ({ ...t, [id]: { error: e?.message || _t("The test failed.") } }));
        }
    };

    return (
        <div className="rx_pipeline">
            <p className="text-muted">
                {_t("Where your companions' AI runs. Built in is Grok Realtime: one xAI model that "
                    + "hears and speaks, on your xAI key. Add connections to other providers (OpenAI, "
                    + "Claude, ElevenLabs, Fish Audio) or to models on this computer, then build voice "
                    + "setups from them. A setup runs its calls on a speech-to-speech model (OpenAI "
                    + "Realtime), or as three engines you choose separately - speech to text, a text "
                    + "model as the brain, and a voice. Its brain can also run the companion's text "
                    + "chat, summaries and tasks. Each companion picks its setup (and its own voice) in "
                    + "the Companions tab; every call feature works on all of them.")}
            </p>
            <label>{_t("Default for companions")}</label>
            <select value={String(defaultSetup || "realtime")} onChange={(ev) => change({ defaultSetup: ev.target.value })}>
                <option value="realtime">{_t("Grok Realtime")}</option>
                {setups.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>

            <h4 className="rx_pipeline_heading">{_t("Connections")}</h4>
            <p className="text-muted small">
                {_t("Where engines live: a server on this computer or a service, entered once and "
                    + "shared by every setup.")}
            </p>
            <div className="rx_pipeline_list">
                {connections.map((c) => c.builtin ? (
                    <Fold key={c.id} title={c.name} summary={_t("Built in - uses the xAI API key above.")} />
                ) : (
                    <Fold key={c.id} title={c.name} open={open.has(`c:${c.id}`)} onToggle={() => toggle(`c:${c.id}`)}
                          summary={[_t(kinds[c.kind]?.label || c.kind), c.settings?.base_url].filter(Boolean).join(" · ")}>
                        <div className="rx_row">
                            <div>
                                <label>{_t("Name")}</label>
                                <input type="text" value={c.name}
                                       onChange={(ev) => setConnection(c.id, { name: ev.target.value })} />
                            </div>
                            {(kinds[c.kind]?.fields || []).map((f) => (
                                <EngineField key={f.key} field={f} value={c.settings?.[f.key]}
                                             onChange={(v) => setConnection(c.id, { settings: { ...c.settings, [f.key]: v } })} />
                            ))}
                        </div>
                        <div className="rx_pipeline_actions">
                            <button className="btn btn-light" onClick={() => removeConnection(c.id)}>
                                <i className="fa fa-trash-o" /> {_t("Remove")}
                            </button>
                        </div>
                    </Fold>
                ))}
            </div>
            <details className="rx_menu">
                <summary className="btn btn-light"><i className="fa fa-plus" /> {_t("Add connection")}</summary>
                <div className="rx_menu_items">
                    {PRESETS.filter((p) => kinds[p.kind]).map((p) => (
                        <button key={p.label} onClick={(ev) => { ev.currentTarget.closest("details").open = false; addConnection(p.label, p.kind, p.url, p.serves); }}>
                            {p.label}
                        </button>
                    ))}
                    {/* "Other" is for servers without a preset; a single-provider
                        kind (OpenAI, Claude, Fish) already has its own entry. */}
                    {catalog.kinds.filter((k) => k.kind === "openai"
                        || (k.kind !== "xai" && !PRESETS.some((p) => p.kind === k.kind))).map((k) => (
                        <button key={k.kind} onClick={(ev) => { ev.currentTarget.closest("details").open = false; addConnection(_t(k.label), k.kind, ""); }}>
                            {_t("Other: %s", _t(k.label))}
                        </button>
                    ))}
                </div>
            </details>

            <h4 className="rx_pipeline_heading">{_t("Voice setups")}</h4>
            <div className="rx_pipeline_list">
                <Fold title={_t("Grok Realtime")}
                      badge={String(defaultSetup || "realtime") === "realtime" ? _t("Default") : null}
                      summary={_t("Built in - xAI's speech-to-speech voice model (Voice model above). The most "
                          + "natural timing; billed per connected minute (about $0.08).")} />
                {setups.map((s) => (
                    <SetupCard key={s.id} setup={s} connections={connections} catalog={catalog}
                               smartTurnAvailable={smartTurnAvailable} engineFor={engineFor}
                               stageFor={stageFor} test={tests[s.id]} dirty={dirty}
                               isDefault={String(defaultSetup) === String(s.id)}
                               open={open.has(`s:${s.id}`)} onToggle={() => toggle(`s:${s.id}`)}
                               onName={(name) => setSetup(s.id, { name })}
                               onStage={(stage, value) => setStage(s, stage, value)}
                               onStages={(patch) => setSetup(s.id, { stages: { ...s.stages, ...patch } })}
                               onRemove={() => removeSetup(s.id)}
                               onTest={() => runTest(s.id)} />
                ))}
            </div>
            <button className="btn btn-light" onClick={addSetup}>
                <i className="fa fa-plus" /> {_t("Add voice setup")}
            </button>
        </div>
    );
}

function SetupCard({ setup, connections, catalog, smartTurnAvailable, engineFor, stageFor, test, dirty,
                     isDefault, open, onToggle, onName, onStage, onStages, onRemove, onTest }) {
    const connOf = (id) => connections.find((c) => String(c.id) === String(id));
    const kindOf = (id) => (id === "xai" ? "xai" : connOf(id)?.kind);
    const engines = Object.fromEntries(STAGES.map(([stage]) =>
        [stage, engineFor(stage, kindOf(setup.stages[stage]?.connection)) || engineFor(stage, "xai")]));
    // Speech-to-speech (server/pipeline/realtime.py): one provider model runs
    // the calls; the brain stage stays for text chat, summaries and tasks.
    const rt = setup.stages.realtime || null;
    const rtEngine = rt ? engineFor("realtime", kindOf(rt.connection)) : null;
    const rtConnections = connections.filter((c) => engineFor("realtime", c.kind));
    const testable = isSaved(setup.id) && !dirty;
    // Folded summary: where each stage runs, plus the brain's model.
    const where = (stage) => connOf(setup.stages[stage]?.connection ?? "xai")?.name || "xAI";
    const model = setup.stages.llm?.model || engines.llm?.fields?.find((f) => f.key === "model")?.default;
    const brainSummary = model ? `${where("llm")} (${model})` : where("llm");
    const summary = rt
        ? _t("%s Realtime (%s) · text and tasks: %s", connOf(rt.connection)?.name || "", rt.model || "", brainSummary)
        : [where("stt"), brainSummary, where("tts")].join(" → ");
    const brainTools = hostedTools(engines.llm, connOf(setup.stages.llm?.connection), setup.stages.llm || {});
    const pickCalls = (connectionId) => {
        if (connectionId == null) return onStages({ realtime: null });
        const patch = { realtime: stageFor("realtime", connectionId) };
        // Text chat and tasks start on the same provider's brain.
        const conn = connOf(connectionId);
        if (String(setup.stages.llm?.connection ?? "xai") === "xai" && engineFor("llm", conn?.kind)) {
            patch.llm = stageFor("llm", conn.id);
        }
        onStages(patch);
    };
    // Speech-to-speech keeps the brain (text chat, summaries, tasks) and the
    // voice (voice messages); speech to text has nothing left to do.
    const shown = rt ? STAGES.filter(([stage]) => stage !== "stt") : STAGES;
    const RT_HEADINGS = { llm: "Brain for text chat, summaries and tasks", tts: "Voice for voice messages" };
    return (
        <Fold title={setup.name} badge={isDefault ? _t("Default") : null} summary={summary}
              open={open} onToggle={onToggle}>
            <div className="rx_row">
                <div>
                    <label>{_t("Name")}</label>
                    <input type="text" value={setup.name} onChange={(ev) => onName(ev.target.value)} />
                </div>
                {(rt || rtConnections.length > 0) && (
                    <div>
                        <label title={_t("A speech-to-speech model hears you and answers in its own voice, with the most natural timing. Separate stages let you mix providers and local models.")}>
                            {_t("Calls run on")}
                        </label>
                        <select value={rt ? String(rt.connection) : ""}
                                onChange={(ev) => pickCalls(ev.target.value
                                    ? rtConnections.find((c) => String(c.id) === ev.target.value)?.id : null)}>
                            <option value="">{_t("Separate stages: speech to text → brain → voice")}</option>
                            {rtConnections.map((c) => (
                                <option key={c.id} value={String(c.id)}>{_t("Speech-to-speech: %s Realtime", c.name)}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
            <div className="rx_pipeline_stages">
                {rt && (
                    <div className="rx_pipeline_stage">
                        <h4><i className="fa fa-bolt" /> {_t("Speech-to-speech")}</h4>
                        {rtEngine?.description && <p className="text-muted small">{_t(rtEngine.description)}</p>}
                        {(rtEngine?.fields || []).map((f) => (
                            <EngineField key={f.key} field={f} value={rt[f.key]}
                                         onChange={(v) => onStage("realtime", { ...rt, [f.key]: v })} />
                        ))}
                    </div>
                )}
                {shown.map(([stage, icon, heading]) => {
                    const st = setup.stages[stage] || {};
                    const engine = engines[stage];
                    // The one already picked stays listed, whatever it offers now.
                    const usable = connections.filter((c) => engineFor(stage, c.kind)
                        && (serves(c, stage) || String(c.id) === String(st.connection)));
                    return (
                        <div key={stage} className="rx_pipeline_stage">
                            <h4><i className={`fa ${icon}`} /> {_t(rt ? RT_HEADINGS[stage] : heading)}</h4>
                            <select value={String(st.connection ?? "xai")}
                                    onChange={(ev) => {
                                        const value = ev.target.value === "xai" ? "xai" : usable.find((c) => String(c.id) === ev.target.value)?.id;
                                        onStage(stage, stageFor(stage, value));
                                    }}>
                                {usable.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                            </select>
                            {engine?.description && <p className="text-muted small">{_t(engine.description)}</p>}
                            {(engine?.fields || []).map((f) => (
                                <EngineField key={f.key} field={f} value={st[f.key]}
                                             onChange={(v) => onStage(stage, { ...st, [f.key]: v })} />
                            ))}
                        </div>
                    );
                })}
            </div>
            {rt ? (
            <ul className="rx_pipeline_notes text-muted small">
                <li>{_t("On calls, web search and code run through delegate_task on the brain above (when it is Claude or OpenAI's own API); MCP servers run at OpenAI during the call.")}</li>
                <li>{_t("OpenAI's voices don't render Grok speech tags ([laugh], <whisper>), so companions aren't taught them on calls. Voice messages use the voice above.")}</li>
                <li>{_t("OpenAI rates (check OpenAI pricing): gpt-realtime-2.1 audio $32 / $64 per million tokens in / out (about 10 tokens a second of your speech, 20 of theirs), gpt-realtime-2.1-mini $10 / $20. A call lasts up to 60 minutes, then reconnects.")}</li>
                <li>{_t("OpenAI limits realtime tokens per minute by your account's usage tier: 40,000 on tier 1, about two replies a minute here (each resends the whole conversation, ~15-20k tokens); 200,000 on tier 2. Over it, a reply waits until the limit allows it.")}</li>
            </ul>
            ) : (
            <ul className="rx_pipeline_notes text-muted small">
                {engines.stt?.streaming
                    ? <li>{smartTurnAvailable && setup.stages.turn?.smart_turn
                        ? _t("Smart Turn ends your turn as soon as you sound finished; %s's own end-of-turn detection is the backstop.", _t(engines.stt.label))
                        : _t("%s decides where your turn ends itself.", _t(engines.stt.label))}</li>
                    : <li>{smartTurnAvailable && setup.stages.turn?.smart_turn
                        ? _t("Turns end when the voice detector hears a pause and Smart Turn judges the thought finished.")
                        : _t("Turns end after a set silence (see Turn taking below).")}</li>}
                {!brainTools.includes("web_search") ? (
                    <li>{_t("Web search, X search and MCP servers run at the brain's provider (xAI, OpenAI's own API or Anthropic), so companions don't have them with this brain.")}</li>
                ) : !brainTools.includes("x_search") && (
                    <li>{_t("X search is Grok's own, so companions don't have it with this brain. Web search and MCP servers run at its provider.")}</li>
                )}
                {engines.tts?.own_tags && (
                    <li>{_t("This voice has expression tags of its own, so companions are taught those instead of Grok's, on calls and for voice messages. Each companion's version is in its editor (Speech tags).")}</li>
                )}
                {!engines.tts?.speech_tags && !engines.tts?.own_tags && (
                    <li>{_t("This voice doesn't render Grok speech tags ([laugh], <whisper>), so companions aren't taught them on calls or for voice messages. Whatever a companion writes is sent to the voice as written. If the model behind it has tags of its own, describe them in each companion's editor (Speech tags).")}</li>
                )}
                {Object.values(engines).some((e) => e?.kind === "xai") && (
                    <li>{_t("xAI rates (check xAI pricing): streaming speech to text $0.20 an hour, voice $15 per million characters, grok-4.3 $1.25 / $2.50 per million tokens in / out ($0.20 cached in).")}</li>
                )}
            </ul>
            )}
            {!rt && <details className="rx_pipeline_turn">
                <summary>{_t("Turn taking")}</summary>
                {catalog.turn.map((f) => (
                    <EngineField key={f.key} field={f} value={setup.stages.turn?.[f.key]}
                                 onChange={(v) => onStage("turn", { ...setup.stages.turn, [f.key]: v })} />
                ))}
            </details>}
            <div className="rx_pipeline_actions">
                <button className="btn btn-light" onClick={onTest} disabled={!testable || test === "busy"}
                        title={!testable ? _t("Save your changes first - the test uses the saved settings.")
                            : rt ? _t("The brain answers once, and OpenAI issues a call key for the speech-to-speech model (checks the key and model name).")
                            : _t("Runs each engine once: the brain answers, the voice speaks a line, and the transcriber hears it back.")}>
                    <i className={`fa ${test === "busy" ? "fa-spinner fa-spin" : "fa-stethoscope"}`} /> {_t("Test")}
                </button>
                <button className="btn btn-light" onClick={onRemove}>
                    <i className="fa fa-trash-o" /> {_t("Remove")}
                </button>
            </div>
            {test && test !== "busy" && <TestResult result={test} />}
        </Fold>
    );
}

/** One connection or setup row: a header that opens the full editor below
 *  it. Rows without children (the built-in ones) are plain headers. */
function Fold({ title, badge, summary, open, onToggle, children }) {
    const foldable = !!children;
    const onKeyDown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        onToggle();
    };
    return (
        <div className="rx_pipeline_card">
            <div className={`rx_pipeline_card_head${foldable ? " rx_pipeline_toggle" : ""}`}
                 {...(foldable ? { role: "button", tabIndex: 0, "aria-expanded": !!open, onClick: onToggle, onKeyDown } : {})}>
                <i className={`fa fa-fw ${foldable ? (open ? "fa-chevron-down" : "fa-chevron-right") : "fa-lock"}`} />
                <b>{title}</b>
                {badge && <span className="rx_pipeline_badge">{badge}</span>}
                <span className="text-muted small rx_pipeline_summary">{summary}</span>
            </div>
            {foldable && open && <div className="rx_pipeline_card_body">{children}</div>}
        </div>
    );
}

function EngineField({ field, value, onChange }) {
    const id = useId();
    const label = _t(field.label);
    const help = field.help ? _t(field.help) : undefined;
    if (field.kind === "bool") {
        return (
            <div className="rx_check" title={help}>
                <input id={id} type="checkbox" checked={!!value} onChange={(ev) => onChange(ev.target.checked)} />
                <label htmlFor={id}>{label}</label>
            </div>
        );
    }
    let input;
    if (field.kind === "select") {
        input = (
            <select value={value ?? field.default} onChange={(ev) => onChange(ev.target.value)}>
                {field.options.map(([v, l]) => <option key={v} value={v}>{_t(l)}</option>)}
            </select>
        );
    } else if (field.kind === "secret") {
        const saved = value === true;
        input = (
            <>
                <input type="password" value={typeof value === "string" ? value : ""}
                       placeholder={saved ? _t("•••••••• (leave blank to keep current key)") : ""}
                       onChange={(ev) => onChange(ev.target.value || (saved ? true : ""))} />
                {saved && (
                    <a href="#" className="small" onClick={(ev) => { ev.preventDefault(); onChange(null); }}>
                        {_t("remove")}
                    </a>
                )}
            </>
        );
    } else if (field.kind === "json") {
        input = (
            <textarea rows={2} value={value ?? ""} placeholder={field.placeholder}
                      onChange={(ev) => onChange(ev.target.value)} />
        );
    } else if (field.kind === "number") {
        input = (
            <input type="number" step="any" value={value ?? ""}
                   onChange={(ev) => onChange(ev.target.value === "" ? field.default : Number(ev.target.value))} />
        );
    } else {
        input = (
            <input type="text" value={value ?? ""} placeholder={field.placeholder}
                   onChange={(ev) => onChange(ev.target.value)} />
        );
    }
    return (
        <div>
            <label title={help}>{label}</label>
            {input}
        </div>
    );
}

function TestResult({ result }) {
    if (result.error) return <p className="text-danger small">{result.error}</p>;
    const rows = [
        ["realtime", _t("Speech-to-speech")],
        ["llm", _t("Brain")],
        ["tts", _t("Voice")],
        ["stt", _t("Speech to text")],
    ];
    const timing = (r) => [
        r.first_ms != null ? _t("first %s ms", r.first_ms) : null,
        r.total_ms != null ? _t("done %s ms", r.total_ms) : null,
    ].filter(Boolean).join(" · ");
    return (
        <div className="rx_pipeline_test">
            {rows.map(([key, label]) => {
                const r = result[key];
                if (!r) return null;
                return (
                    <div key={key} className={r.ok ? "ok" : "bad"}>
                        <b><i className={`fa ${r.ok ? "fa-check" : "fa-times"}`} /> {label}</b>
                        <span>{timing(r)}</span>
                        <span className="text-muted">
                            {r.ok ? (r.text || (r.voice ? _t("voice: %s", r.voice) : "")) : r.error}
                        </span>
                    </div>
                );
            })}
            {result.audio && <audio controls src={result.audio} />}
        </div>
    );
}
