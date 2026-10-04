import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { notification } from "../lib/notification";
import { _t } from "../lib/i18n";
import { useUnsavedGuard } from "../lib/unsaved_guard";
import { UnsavedBar } from "./UnsavedUI.jsx";

// How often the open tab refreshes the connected games.
const OVERVIEW_POLL_MS = 1500;
// Neuro's default address: Randy, the Neuro API's test bot, listens there,
// and many mods ship it as their default.
const NEURO_DEFAULT_PORT = 8000;
// What a game does while its companion isn't on a call (games.OFFCALL_MODES):
// [value, choice, short form for a game's card].
const OFFCALL_OPTIONS = [
    ["wait", "Wait for a call", "waiting for a call"],
    ["separate", "Play in a game chat of its own", "in a game chat"],
    ["latest", "Play in our latest conversation (remembered)", "in your latest conversation"],
];

/** Game integrations: games a companion can play as a real player. The
 *  Neuro API section covers every game and mod built on Neuro-sama's
 *  protocol (server/games.py); Minecraft has its own bot. Saves only its
 *  own fields (config/set accepts partial payloads), so it can't clobber
 *  unsaved edits on the Settings tab. */
export default function GameIntegrationsView({ active }) {
    const [config, setConfig] = useState(null);
    const [agents, setAgents] = useState([]);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const dirtyRef = useRef(false);
    const markDirty = (v) => { dirtyRef.current = v; setDirty(v); };

    const load = async () => {
        try {
            const [cfg, list] = await Promise.all([
                rpc("/api/config/get", {}),
                rpc("/api/agents/list", {}),
            ]);
            setConfig(cfg);
            setAgents(Array.isArray(list) ? list : (list?.agents || []));
            markDirty(false);
        } catch (e) {
            notification.add(e?.message || _t("Could not load settings"), { type: "danger" });
        }
    };
    useEffect(() => {
        if (active && !dirtyRef.current) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active]);

    const setField = (key, value) => { markDirty(true); setConfig((c) => ({ ...c, [key]: value })); };

    const save = async () => {
        setSaving(true);
        try {
            await rpc("/api/config/set", {
                minecraft_brain_connection: config.minecraft_brain_connection || "xai",
                minecraft_brain_model: config.minecraft_brain_model || "",
                minecraft_brain_model_hard: config.minecraft_brain_model_hard || "",
                minecraft_master: config.minecraft_master || "",
                games_neuro_port: Number(config.games_neuro_port) || 0,
                games_default_agent_id: Number(config.games_default_agent_id) || 0,
                games_offcall_mode: config.games_offcall_mode || "wait",
            });
            markDirty(false);
            load();
            return true;
        } catch (e) {
            notification.add(e?.message || _t("Save failed"), { type: "danger" });
            return false;
        } finally {
            setSaving(false);
        }
    };

    const discard = () => load();
    useUnsavedGuard(active, dirty, save, discard);

    if (!config) {
        return <div className="rx_settings"><div className="rx_settings_inner">{_t("Loading…")}</div></div>;
    }
    // Where the bot's planner runs, and that connection kind's default
    // models (minecraft_tools._BRAIN_DEFAULTS).
    const brainChoice = config.minecraft_brain_connection || "xai";
    const brainKind = brainChoice === "xai" ? "xai"
        : (config.minecraft_brain_connections || []).find((c) => c.id === brainChoice)?.kind || "openai";
    const [defaultModel, defaultHard] = {
        xai: ["grok-4.20-non-reasoning", "grok-4.5"],
        anthropic: ["claude-haiku-4-5", "claude-sonnet-5-5"],
        openai_cloud: ["gpt-6-luna", "gpt-6-astra"],
        openai: ["", ""],
    }[brainKind];

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner">
                <NeuroGamesSection active={active} config={config} agents={agents}
                                   setField={setField} />

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
                            <label title={_t("The xAI key from Settings, or an OpenAI-compatible or Claude connection from Settings → Models & providers (its URL and key).")}>
                                {_t("Bot brain connection")}
                            </label>
                            <select value={brainChoice}
                                    onChange={(ev) => {
                                        // Model names belong to a connection: a new one
                                        // starts on its own defaults, not Grok's names.
                                        markDirty(true);
                                        setConfig((c) => ({ ...c, minecraft_brain_connection: ev.target.value,
                                                            minecraft_brain_model: "", minecraft_brain_model_hard: "" }));
                                    }}>
                                <option value="xai">{_t("xAI (Grok)")}</option>
                                {(config.minecraft_brain_connections || []).map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label>{defaultModel ? _t("Bot brain model (empty = %s)", defaultModel) : _t("Bot brain model")}</label>
                            <input type="text"
                                   placeholder={defaultModel || _t("the model's name on that server")}
                                   value={config.minecraft_brain_model || ""}
                                   onChange={(ev) => setField("minecraft_brain_model", ev.target.value)} />
                        </div>
                        <div>
                            <label>{defaultHard ? _t("Hard-task model for big jobs (empty = %s)", defaultHard) : _t("Hard-task model for big jobs (empty = disabled)")}</label>
                            <input type="text"
                                   placeholder={defaultHard}
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

                <UnsavedBar dirty={dirty} saving={saving}
                            onSave={save} onDiscard={discard} />
            </div>
        </div>
    );
}

/** Games over the Neuro API: where to point a game, the dedicated port,
 *  who plays while no call is open, and a live view of every connected
 *  game (its actions, the move it waits on, and the traffic). */
function NeuroGamesSection({ active, config, agents, setField }) {
    const [overview, setOverview] = useState(null);

    useEffect(() => {
        if (!active) return undefined;
        let stopped = false;
        let timer = null;
        const poll = async () => {
            try {
                const res = await rpc("/api/games/overview", {});
                if (!stopped) setOverview(res);
            } catch (e) { /* server restarting — keep the last view */ }
            if (!stopped) timer = setTimeout(poll, OVERVIEW_POLL_MS);
        };
        poll();
        return () => { stopped = true; clearTimeout(timer); };
    }, [active]);

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const address = `${scheme}://${window.location.host}/game`;
    const port = Number(config.games_neuro_port) || 0;
    const listener = overview?.listener;
    const players = agents.filter((a) => a.enable_games && a.active);
    const defaultId = Number(config.games_default_agent_id) || 0;
    const games = overview?.games || [];

    const copy = (text) => {
        navigator.clipboard?.writeText(text).catch(() => {});
    };

    return (
        <section>
            <h3><i className="fa fa-gamepad" /> {_t("Games (Neuro API)")}</h3>
            <p className="text-muted">
                {_t("Rexclaw speaks the Neuro API, the open protocol behind Neuro-sama's game "
                    + "integrations. Games and mods built on it (Slay the Spire 2, Inscryption, "
                    + "Buckshot Roulette, Hollow Knight and many made by the community) connect "
                    + "here, and companions with \"Games\" switched on (Companions tab) play "
                    + "them: the game tells them what is happening and what they can do, and "
                    + "they make their moves while talking it through with you.")}
            </p>
            <p className="text-muted">
                {_t("Best for games played one decision at a time: card games, deck-builders, "
                    + "board games, turn-based roguelikes and visual novels. Fast action games "
                    + "don't work, since every move is a full turn of the model. Each integration "
                    + "is a mod you install into the game; find them at ")}
                <a href="https://github.com/VedalAI/neuro-sdk#example-projects" target="_blank"
                   rel="noreferrer">{_t("the Neuro SDK page")}</a>.
            </p>
            <p className="text-muted">
                {_t("Setup: point the game at this address. Most read it from the "
                    + "NEURO_SDK_WS_URL environment variable, some have a setting of their own. "
                    + "Mods that expect Neuro's default address work untouched once the port "
                    + "below is on.")}
            </p>
            <div className="rx_games_address">
                <code>{address}</code>
                <button type="button" className="btn btn-sm btn-outline-secondary"
                        title={_t("Copy")} onClick={() => copy(address)}>
                    <i className="fa fa-copy" />
                </button>
                <code>NEURO_SDK_WS_URL={address}</code>
                <button type="button" className="btn btn-sm btn-outline-secondary"
                        title={_t("Copy")} onClick={() => copy(`NEURO_SDK_WS_URL=${address}`)}>
                    <i className="fa fa-copy" />
                </button>
            </div>
            <div className="rx_row">
                <div>
                    <label>{_t("Neuro's default address")}</label>
                    <div className="rx_check">
                        <input id="rx_games_port" type="checkbox" checked={port > 0}
                               onChange={(ev) => setField("games_neuro_port", ev.target.checked ? NEURO_DEFAULT_PORT : 0)} />
                        <label htmlFor="rx_games_port">
                            {_t("Also listen on ws://localhost:%s (this computer only)", port || NEURO_DEFAULT_PORT)}
                        </label>
                    </div>
                    {listener?.error && (
                        <div className="text-danger small">{_t("Not listening: %s", listener.error)}</div>
                    )}
                </div>
                <div>
                    <label title={_t("Who plays a game that doesn't choose for itself, like a Neuro mod. The mini-games ask in their library.")}>
                        {_t("Mods play with")}
                    </label>
                    <select value={defaultId}
                            onChange={(ev) => setField("games_default_agent_id", Number(ev.target.value))}>
                        <option value={0}>{players[0] ? _t("%s (first with Games on)", players[0].name) : _t("Nobody has Games on")}</option>
                        {players.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                </div>
                <div>
                    <label title={_t("What a mod does while you aren't on a call with its companion. Off a call, every move and every reply is one text turn on the companion's brain, billed like a chat message.")}>
                        {_t("Mods, off a call")}
                    </label>
                    <select value={config.games_offcall_mode || "wait"}
                            onChange={(ev) => setField("games_offcall_mode", ev.target.value)}>
                        {OFFCALL_OPTIONS.map(([v, label]) => <option key={v} value={v}>{_t(label)}</option>)}
                    </select>
                </div>
            </div>
            {!players.length && (
                <p className="text-muted small">
                    {_t("No companion has \"Games\" switched on yet: turn it on in the Companions tab, under Tools.")}
                </p>
            )}

            <h4 className="rx_games_heading">{_t("Mini-games")}</h4>
            <p className="text-muted">
                {_t("The Rexmaw games deck: Broadside! (a 3D cannon duel), chess, heads-up Hold'em, Connect Four, Liar's Dice, Blackjack, "
                    + "Crazy Eights, Walk the Plank, Rock Paper Scissors and Tic-Tac-Toe, each with its own modes, "
                    + "music, sound effects, backdrops, doubloons and streaks, and the crew chiming in. In the "
                    + "library you pick who you play with and what happens off a call, see the crew's standings, "
                    + "and record each companion's reaction lines in their own voice. Every game has a chat box "
                    + "and a speech bubble for talking while you play.")}
            </p>
            <div>
                <a className="btn btn-primary" href="/games/index.html" target="_blank" rel="noreferrer">
                    <i className="fa fa-puzzle-piece" /> {_t("Open the mini-games library")}
                </a>
            </div>
            <details className="rx_games_howto">
                <summary>{_t("Add your own games")}</summary>
                <p>
                    {_t("Every game is a folder with a game.json (title, description, tags, cover) beside "
                        + "its pages and assets, so a game can be as big as you like: scripts, sounds, "
                        + "three.js scenes. To add your own outside the app (in a private folder), make it "
                        + "an extension: a folder with plugin.json and __init__.py, placed in data/plugins/ "
                        + "or listed under Settings → Extensions, whose static folder holds the game folders.")}
                </p>
                <pre>{`# __init__.py
from pathlib import Path

def setup(api):
    # games/<my-game>/game.json, index.html, assets...
    api.add_static(Path(__file__).parent / 'games')`}</pre>
                <p>
                    {_t("A page loads /games/lib/neuro.js, juice.js and lines.js (and games.css for the same "
                        + "look), then calls RexGame.create() with the game's name, rules and actions. Copy any "
                        + "built-in game as a starting point; web/public/games/README.md has the details, "
                        + "three.js included. The games then appear in the library under the extension's "
                        + "name. Keep games for grown-ups in a private extension like this, out of the app's "
                        + "own folder.")}
                </p>
            </details>

            <h4 className="rx_games_heading">{_t("Connected games")}</h4>
            {!games.length ? (
                <div className="rx_wake_status">
                    {_t("No game connected. Open a mini-game, or start a game with a Neuro API mod.")}
                </div>
            ) : games.map((g) => <GameCard key={g.name} game={g} />)}
        </section>
    );
}

function GameCard({ game }) {
    const logRef = useRef(null);
    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [game.log.at(-1)?.at]);  // the server sends the last 40, so the length stops changing
    const where = game.on_call ? _t("on a call")
        : _t((OFFCALL_OPTIONS.find(([v]) => v === game.offcall) || OFFCALL_OPTIONS[0])[2]);
    const player = `${game.agent_name} (${where})`;
    return (
        <div className="rx_game_card">
            <div className="rx_game_head">
                <b>{game.name}</b>
                <span className="text-muted small">
                    {game.transport === "extension" ? game.source : _t("Neuro API · %s", game.source)}
                    {" · "}{_t("player: %s", player)}
                </span>
            </div>
            {game.force ? (
                <div className="rx_game_force">
                    <i className="fa fa-hourglass-half" /> {game.force.query || _t("Waiting on a move")}
                    <span className="text-muted small"> ({game.force.action_names.join(", ")})</span>
                </div>
            ) : null}
            <div className="rx_game_actions">
                {game.actions.length ? game.actions.map((a) => (
                    <span key={a.name} className="rx_game_action"
                          title={[a.description, a.schema ? JSON.stringify(a.schema) : ""].filter(Boolean).join("\n\n")}>
                        {a.name}
                    </span>
                )) : <span className="text-muted small">{_t("No actions registered")}</span>}
            </div>
            <div className="rx_game_log" ref={logRef}>
                {game.log.map((e, i) => (
                    <div key={i} className={`rx_game_log_${e.kind}`}>
                        <span className="text-muted">{new Date(e.at * 1000).toLocaleTimeString()}</span>
                        {" "}<b>{e.kind}</b> {e.text}
                    </div>
                ))}
            </div>
        </div>
    );
}
