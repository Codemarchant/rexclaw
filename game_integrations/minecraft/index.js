// Rexclaw Minecraft bot sidecar. Run next to (or anywhere that can reach)
// your Rexclaw server:
//
//   cd game_integrations/minecraft && npm install && node index.js
//
// Configuration — CLI flags (or the matching env vars), all optional:
//   --port 25565        (MC_PORT)      Minecraft server port. "Open to LAN"
//                                      prints a NEW random port every time
//                                      the world is opened — re-check it.
//   --host 127.0.0.1    (MC_HOST)      Minecraft server host
//   --username Rex      (MC_USERNAME)
//   --auth offline      (MC_AUTH)      "microsoft" for online-mode servers
//   --version           (MC_VERSION)   auto-negotiated when empty
//   --rexclaw ws://127.0.0.1:8990/ws/minecraft   (REXCLAW_WS)
//   --token secret      (REXCLAW_MC_TOKEN)  shared secret, only needed when
//                                      the server sets REXCLAW_MC_TOKEN
//                                      (recommended for Docker/LAN setups)
//   XAI_API_KEY= / BRAIN_MODEL= / BRAIN_MODEL_HARD=
//                                      env only — normally pushed by the
//                                      server; set to run without Rexclaw
"use strict";

const { BotHost } = require("./bot");
const { Brain } = require("./brain");
const { Bridge } = require("./bridge");
const { Reflexes } = require("./reflexes");

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), "[rexclaw-mc]", ...args);

// Tiny flag parser: --name value. Flags win over env vars.
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) { args[m[1]] = argv[i + 1]; i++; }
}

const host = new BotHost({
    host: args.host || process.env.MC_HOST || "127.0.0.1",
    port: Number(args.port || process.env.MC_PORT) || 25565,
    username: args.username || process.env.MC_USERNAME || "Rex",
    auth: args.auth || process.env.MC_AUTH || "offline",
    version: args.version || process.env.MC_VERSION || "",
}, log);

const baseWs = args.rexclaw || process.env.REXCLAW_WS || "ws://127.0.0.1:8990/ws/minecraft";
const wsToken = args.token || process.env.REXCLAW_MC_TOKEN || "";
const bridge = new Bridge(
    wsToken ? `${baseWs}${baseWs.includes("?") ? "&" : "?"}token=${encodeURIComponent(wsToken)}` : baseWs,
    log,
);
const brain = new Brain(host, {
    log,
    event: (kind, text, urgency) => bridge.event(kind, text, urgency),
});

// Standalone fallback: lets the bot run without a Rexclaw server at all
// (the server normally pushes key + model in its config message).
if (process.env.XAI_API_KEY) {
    brain.configure({
        apiKey: process.env.XAI_API_KEY,
        model: process.env.BRAIN_MODEL || "grok-4-fast-non-reasoning",
        hardModel: process.env.BRAIN_MODEL_HARD || "grok-latest",
    });
}

bridge.onConfig = (msg) => {
    brain.configure({
        apiKey: msg.api_key || brain.config.apiKey,
        model: msg.model || brain.config.model,
        hardModel: msg.hard_model || brain.config.hardModel,
        baseUrl: msg.base_url || brain.config.baseUrl,
        name: msg.name || brain.config.name,
        master: msg.master ?? brain.config.master,
    });
    log(`configured (model ${brain.config.model || "?"}, `
        + `hard ${brain.config.hardModel || "disabled"}, companion ${brain.config.name})`);
};

bridge.onDirective = (msg) => {
    if (!msg.text) return;
    // Honest ack: an unconfigured brain silently dropping directives left
    // the companion narrating work that never started.
    if (!brain.config.apiKey || !brain.config.model) {
        log("directive dropped — brain not configured (no API key/model yet)");
        bridge.event("error", "I can't act on that — my brain has no API key yet (set one in Rexclaw Settings, then reconnect me).", "high");
        return;
    }
    log(`directive${msg.hard ? " (hard model)" : ""}: ${msg.text}`);
    // A directive always replaces the current task — the old "queue it"
    // mode only delayed the replacement, so the user's command looked
    // ignored for minutes and the task was dropped anyway. (interrupt is
    // still honored from the wire for older servers that send it false.)
    brain.push(
        { type: "directive", text: `Directive from your companion: "${msg.text}"`, goal: msg.text, hard: !!msg.hard },
        { interrupt: true },
    );
};

// Self-preservation runs below the brain: auto-eat, fight back, flee,
// escape lava/drowning. Wired onto the host so status() can report it.
const reflexes = new Reflexes(host, {
    event: (kind, text, urgency) => bridge.event(kind, text, urgency),
    // Every reflex action reaches the brain (unthrottled, no LLM call of
    // its own) so it can explain why health/food/position changed.
    behavior: (text) => brain.noteReflex(text),
});
host.reflexes = reflexes;

host.on("spawn", () => bridge.event("online", "I'm in the world and ready.", "low"));
host.on("end", () => bridge.event("offline", "I lost connection to the Minecraft server.", "normal"));

// Kicks and connection errors used to reach the console only — the user
// just saw the bot go silent and had no idea why.
host.on("kicked", (reason) => {
    bridge.event("error", `I got kicked from the server: ${reason}`, "high");
});
host.on("error", (message, hint) => {
    bridge.event("error", hint
        ? `I can't join the world — ${hint}`
        : `Something went wrong with my connection: ${message}`, "high");
});

// Ambient world news: buffered for the brain's next turn (no LLM call of
// its own) and passed to the companion as quiet context.
host.on("ambient", (kind, text) => {
    brain.noteAmbient(text);
    bridge.event(kind, text, "low");
});

// A private message deserves a real answer, so this one wakes the brain.
host.on("whisper", (username, message) => {
    brain.noteAmbient(`${username} whispered: "${message}"`);
    bridge.event("chat", `${username} whispered to me: "${message}"`, "low");
    brain.push({ type: "chat", text: `Player ${username} whispered privately to you: "${message}"` });
});

const shutdown = (signal) => {
    log(`shutting down (${signal})`);
    brain.persistNow();
    reflexes.stop();
    host.stop();
    bridge.stop();
    process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));   // Docker stop must persist too

// A generated script that busy-waits after its first await blocks the main
// event loop with nothing in-process able to interrupt it — timers, the
// bridge, and reflexes all freeze. A watchdog thread notices the stall and
// kills the process; state persists every turn, so a restart resumes.
const { Worker } = require("node:worker_threads");
const stallWorker = new Worker(
    `const { parentPort } = require("node:worker_threads");
    let last = Date.now();
    parentPort.on("message", () => { last = Date.now(); });
    setInterval(() => {
        if (Date.now() - last > 30000) {
            console.error("[rexclaw-mc] main thread stalled >30s (a generated script is busy-waiting) — killing the process; restart the sidecar to resume");
            try { process.kill(process.pid, "SIGKILL"); } catch (e) { process.exit(3); }
        }
    }, 5000);`,
    { eval: true },
);
stallWorker.unref();
setInterval(() => { try { stallWorker.postMessage(0); } catch (e) { /* worker gone */ } }, 2000).unref();

host.start();
bridge.start(host, () => brain.statusFields());
log("sidecar up — waiting for the game and the Rexclaw server");
