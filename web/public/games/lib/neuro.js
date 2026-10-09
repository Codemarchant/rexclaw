/*
 * Rexclaw mini-games kit: a Neuro API game client plus the bits every game
 * page shares. Plain script, no build step. A game page loads, in order,
 * neuro.js (this), juice.js (sound + effects) and lines.js (reaction
 * lines), then calls RexGame.create().
 *
 * Protocol: github.com/VedalAI/neuro-sdk/blob/main/API/SPECIFICATION.md
 *
 * Written for the companion on a realtime voice call, which answers fast
 * and thinks little, so every game here follows the same rules:
 * - Register the actions once and keep them; validate every move and refuse
 *   with the valid options spelled out.
 * - Short state, with the facts a player sees at a glance written down
 *   ("you can win in column 5"): the model reads stated facts well and
 *   works things out badly.
 * - Forgiving input: "8 of hearts", "8H" and "eight of hearts" are one card.
 * - One force at a time; withdraw it when the moment passes (cancelForce).
 *
 * Beyond the protocol, each page gets:
 * - the companion it plays with, from the library (?companion=&offcall= in
 *   its URL, passed on to Rexclaw);
 * - a save per game per companion (game.saved / save / record), with
 *   doubloons (game.award), streaks and the end-of-game screen (game.end);
 * - modes (a bar under the header, remembered in the save);
 * - a speech bubble and a chat box (Rexclaw's rexclaw/say and rexclaw/chat),
 *   and off a call, the companion's recorded reaction lines (game.react).
 *
 * Optional hooks for a game that listens to the companion as well as
 * asking them (all off by default):
 * - onSay(text): what the companion said (spoken on a call, typed off one);
 * - onThinking(on): an off-call turn started or ended;
 * - onSpeechEnd(): the companion finished a reply (Neuro's speech_finished);
 * - onVoiceLine(audio, {text, event}): one of their recorded reaction lines
 *   started playing (an <audio> element, for lip-sync).
 * game.end({ quip }) replaces the result screen's small print.
 *
 * RexGame.sfxVolume (get / set / on) is the Effects volume the ⚙ menu's
 * slider moves for every game (juice.js honours it; a game with its own
 * sound bus multiplies by get() and follows on()).
 */
(function () {
  "use strict";

  /** Throw from onAction to refuse a move; the message goes to the companion. */
  class Refuse extends Error {}

  // The result screen's small print.
  const END_QUIPS = {
    win: ["The crew will be talking about this for days.", "Rex has logged it. In the good book.", "Somebody fetch the ship's bell.",
      "A shanty will be written. It will be terrible.", "The parrot is already telling everyone.", "Ara is baking a celebration cake."],
    loss: ["The sea is cruel. So is your opponent.", "Sal says the odds were 'interesting'.", "There's always the next tide.",
      "Leo has called for notes in the morning.", "Even Rex loses sometimes. Mostly to Sal.", "Walk it off. Not the plank. Just walk it off."],
    draw: ["Perfectly balanced, as all things on the Rexmaw should be.", "Nobody swabs the deck today.", "Eve is thrilled. Rare data."],
  };

  const local = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const voiceOn = () => local.get("rx-games-voice") === "1";

  // The Effects volume every game shares (the ⚙ menu's slider): 0..1, kept
  // per browser. juice.js scales its sounds by it; a game with sounds of its
  // own reads it (get) and follows it (on). 1 = as loud as the games always were.
  const SFX_VOL_KEY = "rx-games-sfx-vol";
  const clampVol = (v) => Math.min(1, Math.max(0, Number(v)));
  const sfxVolSubs = new Set();
  let sfxVol = (() => { const n = parseFloat(local.get(SFX_VOL_KEY)); return Number.isFinite(n) ? clampVol(n) : 1; })();
  function setSfxVol(v, persist) {
    const n = clampVol(v);
    if (!Number.isFinite(n) || n === sfxVol) return sfxVol;
    sfxVol = n;
    if (persist) local.set(SFX_VOL_KEY, String(n));
    for (const fn of sfxVolSubs) { try { fn(n); } catch (e) { console.error(e); } }
    return sfxVol;
  }
  const sfxVolume = {
    get: () => sfxVol,
    set: (v) => setSfxVol(v, true),
    /** Hear changes: fn(volume) → off(). */
    on(fn) { if (typeof fn === "function") sfxVolSubs.add(fn); return () => sfxVolSubs.delete(fn); },
  };
  // Another tab moved it: follow (without writing it back).
  addEventListener("storage", (e) => { if (e.key === SFX_VOL_KEY && e.newValue != null) setSfxVol(parseFloat(e.newValue), false); });

  // One voice at a time: the companion's recorded reactions and the crew's
  // cameos (crew.js) queue behind each other instead of talking over each
  // other. A line that waited too long is dropped: a late reaction is stale.
  const voiceQueue = [];
  let voicePlaying = null;
  function playVoice(url, { onStart = null, volume = 1, maxWait = 4000 } = {}) {
    voiceQueue.push({ url, onStart, volume, until: Date.now() + maxWait });
    if (!voicePlaying) nextVoice();
  }
  function nextVoice() {
    voicePlaying = null;
    let item = voiceQueue.shift();
    while (item && Date.now() > item.until) item = voiceQueue.shift();
    if (!item) return;
    const a = new Audio(item.url);
    a.volume = item.volume;
    voicePlaying = a;
    const done = () => { if (voicePlaying === a) nextVoice(); };
    a.onended = done; a.onerror = done;
    a.play().then(() => {
      item.onStart?.(a);
      window.RexGame.music?.duck?.(Math.max(2, (a.duration || 2.5) + 0.4));
    }).catch(done);
  }
  const sfx = (name, ...args) => window.RexGame.sfx?.[name]?.(...args);
  const fx = (name, ...args) => window.RexGame.fx?.[name]?.(...args);

  // The kit's own widgets are styled by kit.css, next to this file: load it
  // here so a game with a look of its own needs no shared stylesheet.
  const LIB = document.currentScript?.src.replace(/[^/]*$/, "") || "/games/lib/";
  if (!document.querySelector('link[href$="kit.css"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = `${LIB}kit.css`;
    document.head.appendChild(link);
  }

  /**
   * ui: which kit furniture the page wants: { toolbar, record, dock } (all on
   * by default; a page without the .rx-top header gets a floating toolbar),
   * plus recordInto / modesInto (elements) to place those yourself.
   * music: track ids from music.js the player can pick from (first = default).
   * scenes: backdrop ids from scenes.js (first = default); seagulls fly
   * through them now and then.
   */
  function create({ name, rules, actions, onAction, onCompanion, onConnect, onLoad, onAgain,
                    modes = null, onMode = null, chat = true, ui = {}, music = [], scenes = [], seagulls = null,
                    onSay = null, onThinking = null, onSpeechEnd = null, onVoiceLine = null }) {
    const game = { name, companion: "Your companion", companionId: 0, connected: false, saved: {},
                   mode: modes?.[0]?.id || null, sessionPoints: 0 };
    let ws = null;
    let force = null;          // the actions/force data while one is open
    let held = null;           // messages sent while an action is answered
    let loadedFor = null;      // the companion whose save is loaded
    let saveTimer = null;
    let lastReact = 0;
    const prefKey = (k) => `rx-${k}-${name}`;
    mountToolbar();
    const recordEl = ui.record === false ? null : mountRecord(ui.recordInto);
    const modeBar = modes ? mountModes(modes, (id) => setMode(id, true), ui.modesInto) : null;
    const dock = chat && ui.dock !== false ? mountDock(game, (text) => send("rexclaw/chat", { text })) : null;

    // ---- Music, backdrop, gulls -------------------------------------------------

    const musicPick = () => {
      const saved = local.get(prefKey("music"));
      return saved === "off" ? null : (music.includes(saved) ? saved : music[0] || null);
    };
    // Browsers only start sound after a gesture: the first click starts the band.
    if (music.length) {
      const start = () => { if (musicPick() && !window.RexGame.music?.playing()) window.RexGame.music?.play(musicPick()); };
      addEventListener("pointerdown", start, { once: true, capture: true });
      addEventListener("keydown", start, { once: true, capture: true });
    }
    if (scenes.length) {
      const saved = local.get(prefKey("scene"));
      window.RexGame.scenes?.set(scenes.includes(saved) ? saved : scenes[0]);
    }
    if (seagulls ?? scenes.length > 0) {
      const gull = () => {
        setTimeout(gull, 70000 + Math.random() * 90000);
        if (document.hidden) return;
        // A bonk is rare and on purpose: someone always notices. The gallery
        // (never your opponent) and your opponent, live when on a call.
        fx("seagull", (el) => {
          game.award(5, "", el, { quiet: true });
          game.heckle("seagull");
          game.react("seagull", { onCall: "The user just bonked a seagull out of the sky with a well-aimed click." });
        });
      };
      setTimeout(gull, 25000 + Math.random() * 40000);
      // Rarer visitors, one every few minutes: a bottle with the Captain's
      // orders, Evie the cat, the Kraken after your doubloons.
      const visit = () => {
        setTimeout(visit, 110000 + Math.random() * 130000);
        if (document.hidden || document.querySelector(".rx-end")) return;
        const roll = Math.random();
        if (roll < 0.4) visitBottle(); else if (roll < 0.75) visitCat(); else visitKraken();
      };
      setTimeout(visit, 60000 + Math.random() * 60000);
    }

    // The Captain's orders, as they come by bottle (the crew's lore: nobody
    // has met the Captain; the orders just wash in).
    const ORDERS = [
      "Feed the parrot. Not the cards.",
      "Whoever reads this: you're doing great. Also, swab the deck.",
      "Rex: stop naming things after yourself.",
      "The Kraken is NOT to be fed after midnight.",
      "Chum Crunch is not a currency. This means you, Sal.",
      "Eve, the evidence file is getting heavy. Proud of you.",
      "Lights out at eight bells. Leo, that includes the theatre.",
      "Play fair. Win anyway.",
      "Do not bonk the seagulls. (I know it was you.)",
      "Ara's tea is not optional.",
      "Evie the cat outranks the parrot. Effective immediately.",
      "If found, return to the Captain. You'll know where.",
    ];
    function visitBottle() {
      fx("bottle", (el) => {
        const order = ORDERS[(Math.random() * ORDERS.length) | 0];
        fx("scroll", order);
        game.award(15, "", el, { quiet: true });
        game.heckle("bottle", { minGap: 0 });
        game.react("bottle", { onCall: `The user fished a message in a bottle out of the sea, in the Captain's hand: "${order}"` });
      });
    }
    function visitCat() {
      fx("cat", (el) => {
        game.award(5, "Purr...", el);
        game.heckle("cat", { minGap: 0 });
        game.react("cat", { onCall: "Evie the cat just strolled across the game, and the user stopped to pet her." });
      });
    }
    function visitKraken() {
      game.heckle("tentacle", { minGap: 0 });
      fx("tentacle", (el) => game.award(10, "Shooed!", el),
        (el) => {
          game.award(-10, "Kraken tax", el);
          game.heckle("kraken_tax", { minGap: 0 });
          game.react("kraken_tax", { onCall: "A Kraken tentacle crept up and stole 10 of the user's doubloons while they weren't looking." });
        });
    }

    /** A Rexmaw crew member chimes in (crew.js). Your opponent never does. */
    game.heckle = (event, opts = {}) => window.RexGame.crew?.heckle(event, { game: name, exclude: game.companion, ...opts });

    // ---- The settings menu ----------------------------------------------------

    function mountToolbar() {
      if (ui.toolbar === false) return;
      let top = document.querySelector(".rx-top");
      let box;
      if (top) {
        box = document.createElement("span");
        box.className = "rxk-tools";
        top.insertBefore(box, document.getElementById("rx-link"));
      } else {
        box = document.createElement("div");
        box.className = "rxk-tools rxk-floatbar";
        if (!document.getElementById("rx-link")) box.innerHTML = '<span id="rx-link" class="rxk-pill off">Connecting…</span>';
        document.body.appendChild(box);
      }
      const cog = document.createElement("button");
      cog.className = "rxk-icon"; cog.textContent = "⚙"; cog.title = "Sound, music and more";
      box.insertBefore(cog, box.firstChild);
      let menu = null;
      cog.onclick = (ev) => {
        ev.stopPropagation();
        if (menu) { menu.remove(); menu = null; return; }
        sfx("click");
        menu = buildMenu();
        box.appendChild(menu);
      };
      document.addEventListener("click", (ev) => { if (menu && !menu.contains(ev.target)) { menu.remove(); menu = null; } });
    }

    function buildMenu() {
      const R = window.RexGame, m = document.createElement("div");
      m.className = "rxk-menu";
      const tracks = music.filter((id) => R.music?.TRACKS[id]);
      m.innerHTML = "<h4>Ship's settings</h4>"
        + `<label>Sound effects <input type="checkbox" data-k="sfx" ${R.sfx?.muted() ? "" : "checked"}></label>`
        + `<label title="Effects volume, for every game">Effects <input type="range" min="0" max="1" step="0.05" value="${sfxVolume.get()}" data-k="sfxvol" aria-label="Effects volume"></label>`
        + (tracks.length ? `<label>Music <select data-k="music"><option value="off">Off</option>${tracks.map((id) =>
          `<option value="${id}" ${musicPick() === id ? "selected" : ""}>${R.escape(R.music.TRACKS[id].name)}</option>`).join("")}</select></label>`
          + `<label>Volume <input type="range" min="0" max="1" step="0.05" value="${R.music.volume()}" data-k="vol"></label>` : "")
        + (scenes.length > 1 ? `<label>Backdrop <select data-k="scene">${scenes.map((id) =>
          `<option value="${id}" ${R.scenes?.current() === id ? "selected" : ""}>${R.escape(R.scenes.LIST[id] || id)}</option>`).join("")}</select></label>` : "")
        + `<label>${R.escape(game.companion)}'s voice lines <input type="checkbox" data-k="voice" ${voiceOn() ? "checked" : ""}></label>`
        + '<div class="rxk-sub">Off a call; record them in the library.</div>'
        + `<label>Crew cameos <input type="checkbox" data-k="crew" ${R.crew?.enabled() !== false ? "checked" : ""}></label>`
        + '<div class="rxk-sub">Rex and the crew chime in from the gallery.</div>';
      m.onclick = (ev) => ev.stopPropagation();
      m.querySelector('[data-k="sfx"]').onchange = (ev) => { R.sfx?.setMuted(!ev.target.checked); sfx("click"); };
      const sv = m.querySelector('[data-k="sfxvol"]');
      sv.oninput = () => sfxVolume.set(Number(sv.value));
      sv.onchange = () => sfx("click");   // a tick at the new level once the slider lets go
      m.querySelector('[data-k="voice"]').onchange = (ev) => { local.set("rx-games-voice", ev.target.checked ? "1" : "0"); sfx("click"); };
      m.querySelector('[data-k="crew"]').onchange = (ev) => { R.crew?.setEnabled(ev.target.checked); sfx("click"); };
      const mus = m.querySelector('[data-k="music"]');
      if (mus) mus.onchange = () => { local.set(prefKey("music"), mus.value); if (mus.value === "off") R.music.stop(); else R.music.play(mus.value); };
      const vol = m.querySelector('[data-k="vol"]');
      if (vol) vol.oninput = () => R.music.setVolume(Number(vol.value));
      const sc = m.querySelector('[data-k="scene"]');
      if (sc) sc.onchange = () => { local.set(prefKey("scene"), sc.value); R.scenes.set(sc.value); sfx("whoosh"); };
      return m;
    }

    // ---- Saves ---------------------------------------------------------------

    function api(path, body) {
      return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${path}: ${r.status}`))));
    }

    function load() {
      const id = game.companionId;
      if (loadedFor === id) return;
      loadedFor = id;
      api("/api/games/save/get", { game: name, agent_id: id })
        .then((res) => {
          if (loadedFor !== id) return;
          game.saved = res.data || {};
          showRecord();
          if (modes && game.saved.mode && game.saved.mode !== game.mode && modes.some((m) => m.id === game.saved.mode)) {
            setMode(game.saved.mode, false);
          }
          onLoad?.(game.saved);
        })
        .catch(() => {});
    }

    /** Merge `patch` into the save and store it (a moment later, once). */
    game.save = (patch = {}) => {
      Object.assign(game.saved, patch);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api("/api/games/save/set", { game: name, agent_id: game.companionId, data: game.saved }).catch(() => {});
      }, 300);
    };

    /** Count a finished game, from the USER's side: "win", "loss" or "draw".
     *  Keeps the win streak too. Returns the record. */
    game.record = (outcome) => {
      const rec = { wins: 0, losses: 0, draws: 0, ...(game.saved.record || {}) };
      const key = { win: "wins", loss: "losses", draw: "draws" }[outcome];
      if (key) rec[key]++;
      const streak = outcome === "win" ? (game.saved.streak > 0 ? game.saved.streak + 1 : 1)
        : outcome === "loss" ? (game.saved.streak < 0 ? game.saved.streak - 1 : -1) : 0;
      game.save({ record: rec, streak, bestStreak: Math.max(game.saved.bestStreak || 0, streak),
                  lastPlayed: new Date().toISOString() });
      showRecord();
      return rec;
    };

    /** Doubloons: `points` for `label` ("Blocked!"), popping from `at`. */
    game.award = (points, label = "", at = null, { quiet = false } = {}) => {
      if (!points) return;
      game.sessionPoints += points;
      game.save({ points: (game.saved.points || 0) + points });
      if (!quiet) {
        fx("float", `${points > 0 ? "+" : ""}${points}${label ? " " + label : ""}`, { at, color: points > 0 ? "#facc15" : "#f87171" });
        sfx(points > 0 ? "coin" : "error");
      }
      showRecord();
    };

    /** Keep a best score (higher is better) and say whether it's new. */
    game.best = (score, key = game.mode || "best") => {
      const best = { ...(game.saved.best || {}) };
      const isNew = !(key in best) || score > best[key];
      if (isNew) { best[key] = score; game.save({ best }); }
      return isNew;
    };

    /** The end of a game: record, doubloons, sound, confetti or a shake,
     *  the companion's reaction and the result screen.
     *  outcome is the USER's: "win", "loss" or "draw". */
    game.end = ({ outcome, points = 0, title = null, detail = "", jackpot = false, quip = null }) => {
      const rec = game.record(outcome);
      if (points) game.award(points, "", null, { quiet: true });
      const streak = game.saved.streak || 0;
      if (outcome === "win") { sfx(jackpot ? "jackpot" : "win"); fx("confetti", { coins: true }); }
      else if (outcome === "loss") { sfx("lose"); fx("shake"); }
      else sfx("draw");
      game.react(outcome === "win" ? (streak >= 3 ? "user_streak" : "they_lose")
        : outcome === "loss" ? (streak <= -3 ? "their_streak" : "they_win") : "draw");
      // The gallery has opinions too, a beat after your opponent's.
      setTimeout(() => game.heckle(outcome === "win" ? "user_win" : outcome === "loss" ? "user_loss" : "draw",
        { chance: 0.7, minGap: 0 }), 2600);
      showEnd({ outcome, points, title, detail, rec, streak,
                quip: quip ?? END_QUIPS[outcome][(Math.random() * END_QUIPS[outcome].length) | 0] });
    };

    function showRecord() {
      if (!recordEl) return;
      const s = game.saved, rec = s.record;
      const bits = [];
      bits.push(`<span class="dbl">⚓ ${(s.points || 0).toLocaleString()} doubloons</span>`);
      if (rec) bits.push(`vs ${RexGame.escape(game.companion)}: <b>${rec.wins}</b>W <b>${rec.losses}</b>L${rec.draws ? ` <b>${rec.draws}</b>D` : ""}`);
      if (s.streak >= 2) bits.push(`<span class="hot">🔥 ${s.streak} in a row</span>`);
      if (s.streak <= -2) bits.push(`<span class="cold">🥶 ${-s.streak} lost in a row</span>`);
      recordEl.innerHTML = bits.join(" · ");
    }

    function showEnd({ outcome, points, title, detail, rec, streak, quip }) {
      document.querySelector(".rx-end")?.remove();
      const el = document.createElement("div");
      el.className = `rx-end ${outcome}`;
      const head = title || { win: "VICTORY!", loss: "DEFEAT", draw: "DRAW" }[outcome];
      el.innerHTML = `<div class="card"><div class="title">${RexGame.escape(head)}</div>`
        + (detail ? `<div class="detail">${RexGame.escape(detail)}</div>` : "")
        + (points ? `<div class="pts">+${points} doubloons</div>` : "")
        + (quip ? `<div class="quip">${RexGame.escape(quip)}</div>` : "")
        + `<div class="sub">All-time vs ${RexGame.escape(game.companion)}: ${rec.wins}W ${rec.losses}L${rec.draws ? ` ${rec.draws}D` : ""}`
        + (streak >= 2 ? ` · 🔥 ${streak} in a row` : "") + "</div>"
        + `<div class="rxk-bar"><button class="rxk-btn primary" data-again>Play again</button>`
        + `<button class="rxk-btn" data-close>Look at the board</button></div></div>`;
      el.querySelector("[data-again]").onclick = () => { el.remove(); sfx("click"); onAgain?.(); };
      el.querySelector("[data-close]").onclick = () => { el.remove(); sfx("click"); };
      document.body.appendChild(el);
    }

    // ---- Modes ---------------------------------------------------------------

    function setMode(id, byUser) {
      if (!modes?.some((m) => m.id === id)) return;
      game.mode = id;
      modeBar?.show(id);
      if (byUser) { sfx("click"); game.save({ mode: id }); }
      onMode?.(id, byUser);
    }

    // ---- Reactions -------------------------------------------------------------

    /** The companion reacts to `event` with one of its recorded lines (see
     *  lines.js): text in the bubble, and their voice when voice lines are
     *  on and recorded. Not on a call - they react live there; `onCall`
     *  tells them what happened so they can, for an event the game doesn't
     *  report to them anyway (a bonked seagull). */
    game.react = (event, { onCall = null } = {}) => {
      const now = Date.now();
      if (now - lastReact < 3500 || !game.companionId) return;
      const text = RexGame.pickLine?.(name, event);
      if (!text) return;
      lastReact = now;
      api("/api/games/voiceline", { agent_id: game.companionId, text, record: false })
        .then((res) => {
          if (res.on_call) { if (onCall) game.tell(onCall, false); return; }
          dock?.say(text, { quip: true });
          if (!voiceOn()) return;
          if (res.url) playVoice(res.url, { onStart: (a) => { try { onVoiceLine?.(a, { text, event }); } catch { /* lip-sync is a nicety */ } } });
          // Not recorded yet: record it now for next time.
          else if (!res.error) api("/api/games/voiceline", { agent_id: game.companionId, text, record: true }).catch(() => {});
        })
        .catch(() => {});
    };

    // ---- Protocol -------------------------------------------------------------

    function send(command, data) {
      if (held) { held.push([command, data]); return; }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ command, game: name, data }));
    }

    /** Tell the companion something. silent: know it, don't react now. */
    game.tell = (message, silent = true) => send("context", { message, silent });

    /** Say something to the companion as the user (what the chat box sends):
     *  a call hears it as a prompt; off a call it wakes a text turn. */
    game.chat = (text) => { const line = String(text ?? "").trim(); if (line) send("rexclaw/chat", { text: line.slice(0, 500) }); };

    /** Ask the companion for one of `actions` now. The state is resent with
     *  every force, so it is ephemeral (the docs' advice for repeated state).
     *  afterUser: the user's input (a move, a deal) set this off. By default,
     *  a force made while answering the companion's own move (in onAction)
     *  is not, and anything else is. That picks the default priority, Neuro's:
     *  "low" lets them finish talking about their move first; "high" cuts that
     *  talk short when the user plays on. A call also times the user's
     *  answers on afterUser forces to spot rapid play (Rexclaw only). */
    game.force = ({ state, query, actions: names, priority = null, afterUser = null }) => {
      const user = afterUser ?? held === null;
      force = { state, query, action_names: names, ephemeral_context: true, priority: priority || (user ? "high" : "low") };
      if (user) force.rexclaw_after_user = true;
      send("actions/force", force);
    };

    /** The moment passed (new game, the user took over): withdraw the force
     *  the way the spec does it, by unregistering its actions, then put them
     *  back for next time. */
    game.cancelForce = () => {
      if (!force) return;
      const names = force.action_names;
      force = null;
      send("actions/unregister", { action_names: names });
      send("actions/register", { actions: actions.filter((a) => names.includes(a.name)) });
    };

    game.waiting = () => !!force;

    function answer(id, success, message) {
      const queued = held;
      held = null;
      send("action/result", { id, success, message: message || "" });
      // Whatever the move set off (the next force, a game-over note) goes
      // after its result: the result must reach the companion first.
      for (const [command, data] of queued || []) send(command, data);
    }

    function onActionMessage({ id, name: action, data }) {
      let args = {};
      try { args = data ? JSON.parse(data) : {}; } catch { return answer(id, false, "The data was not valid JSON."); }
      if (!actions.some((a) => a.name === action)) return answer(id, false, `This game has no action "${action}".`);
      held = [];
      const before = force;
      try {
        const message = onAction(action, args || {});
        // The move answered the open force, unless it set off a new one.
        if (force === before && before?.action_names.includes(action)) force = null;
        answer(id, true, message);
      } catch (e) {
        if (!(e instanceof Refuse)) console.error(e);
        answer(id, false, e instanceof Refuse ? e.message : `That move broke the game: ${e.message}`);
      }
    }

    function connect() {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      // The library's pick of companion and off-call mode rides along.
      const here = new URLSearchParams(location.search), pass = new URLSearchParams();
      for (const key of ["companion", "offcall", "token"]) if (here.get(key)) pass.set(key, here.get(key));
      ws = new WebSocket(`${scheme}://${location.host}/game${pass.toString() ? "?" + pass : ""}`);
      ws.onopen = () => {
        game.connected = true;
        setLink(true);
        send("startup");
        if (rules) send("context", { message: rules, silent: true });
        send("actions/register", { actions });
        // A move still owed when the link dropped: asked again, but it answers
        // nothing new, so it isn't timed as the user's.
        if (force) send("actions/force", { ...force, rexclaw_after_user: undefined });
        onConnect?.();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.command === "startup" && msg.data?.session?.displayName) {
          const first = !game.companionId;
          game.companion = msg.data.session.displayName;
          game.companionId = msg.data.session.rexclaw?.agentId || 0;
          document.querySelectorAll("[data-companion]").forEach((el) => { el.textContent = game.companion; });
          dock?.setName(game.companion);
          setLink(true);
          load();
          onCompanion?.(game.companion);
          if (first) {
            setTimeout(() => game.react("greet"), 900);
            setTimeout(() => game.heckle("start", { chance: 0.55 }), 5000);
          }
        } else if (msg.command === "actions/reregister_all") {
          send("actions/register", { actions });
        } else if (msg.command === "action") {
          onActionMessage(msg.data || {});
        } else if (msg.command === "rexclaw/say") {
          const text = msg.data?.text || "";
          dock?.say(text);
          try { onSay?.(text); } catch (e) { console.error(e); }
        } else if (msg.command === "rexclaw/thinking") {
          dock?.thinking(!!msg.data?.on);
          try { onThinking?.(!!msg.data?.on); } catch (e) { console.error(e); }
        } else if (msg.command === "speech_finished") {
          try { onSpeechEnd?.(); } catch (e) { console.error(e); }
        }
      };
      ws.onclose = () => {
        game.connected = false;
        setLink(false);
        setTimeout(connect, 2000);
      };
    }

    function setLink(on) {
      const el = document.getElementById("rx-link");
      if (!el) return;
      el.textContent = on ? `Playing with ${game.companion}` : "Not connected";
      el.classList.toggle("on", on);
      el.classList.toggle("off", !on);
    }

    connect();
    return game;
  }

  // ---- Page furniture --------------------------------------------------------

  /** The doubloons-and-record line: inside `into`, else under the header. */
  function mountRecord(into) {
    const top = document.querySelector(".rx-top");
    if (!into && !top) return null;
    const el = document.createElement("div");
    el.className = "rx-record";
    if (into) into.appendChild(el); else top.after(el);
    return el;
  }

  /** The game's modes, as a row of tabs: inside `into`, else under the
   *  record line. */
  function mountModes(modes, onPick, into) {
    const bar = document.createElement("div");
    bar.className = "rx-modes";
    for (const m of modes) {
      const b = document.createElement("button");
      b.dataset.mode = m.id;
      b.innerHTML = `${m.label}${m.hint ? `<small>${RexGame.escape(m.hint)}</small>` : ""}`;
      b.onclick = () => onPick(m.id);
      bar.appendChild(b);
    }
    if (into) into.appendChild(bar);
    else (document.querySelector(".rx-record") || document.querySelector(".rx-top") || document.body.firstElementChild).after(bar);
    const show = (id) => bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === id));
    show(modes[0].id);
    return { show };
  }

  /** The speech bubble and chat box at the foot of every game. */
  function mountDock(game, onSend) {
    const dock = document.createElement("div");
    dock.className = "rx-dock";
    dock.innerHTML = '<div class="rx-bubble" hidden><b></b><span class="text"></span></div>'
      + '<form class="rx-chat"><input maxlength="500" autocomplete="off"><button class="rxk-btn" type="submit">Send</button></form>';
    document.body.appendChild(dock);
    document.body.classList.add("rx-has-dock");
    const bubble = dock.querySelector(".rx-bubble"), who = bubble.querySelector("b"), text = bubble.querySelector(".text");
    const input = dock.querySelector("input");
    const setName = (name) => { who.textContent = name; input.placeholder = `Say something to ${name}…`; };
    setName(game.companion);
    dock.querySelector("form").onsubmit = (ev) => {
      ev.preventDefault();
      const line = input.value.trim();
      if (!line || !game.connected) return;
      onSend(line);
      sfx("whoosh");
      input.value = "";
    };
    return {
      setName,
      say(line, { quip = false } = {}) {
        if (!line) return;
        bubble.hidden = false;
        bubble.classList.remove("typing");
        bubble.classList.toggle("quip", quip);
        text.textContent = line;
        bubble.classList.remove("pop"); void bubble.offsetWidth; bubble.classList.add("pop");
        sfx("bubble");
      },
      thinking(on) {
        if (on) { bubble.hidden = false; bubble.classList.add("typing"); text.textContent = "…"; }
        else if (bubble.classList.contains("typing")) { bubble.classList.remove("typing"); bubble.hidden = true; }
      },
    };
  }

  // ---- Shared helpers ------------------------------------------------------

  const UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
  const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");

  /** "seventy-two" → 72, "a hundred and five" → 105; NaN if it isn't one. */
  function wordsToInt(text) {
    let total = 0, seen = false;
    for (const part of text.replace(/-/g, " ").split(/\s+/).filter(Boolean)) {
      if (UNITS.includes(part)) total += UNITS.indexOf(part);
      else if (TENS.includes(part)) total += (TENS.indexOf(part) + 2) * 10;
      else if (part === "hundred") total = (total || 1) * 100;
      else if (part === "and" || part === "a") continue;
      else return NaN;
      seen = true;
    }
    return seen ? total : NaN;
  }

  /** A whole number from 4, "4", "four", "seventy-two" or "4s"; NaN otherwise. */
  function toInt(value) {
    if (typeof value === "number") return Math.trunc(value);
    const text = String(value ?? "").trim().toLowerCase();
    // "threes", "sixes", "4s": a face named in the plural
    for (const t of [text, text.replace(/s$/, ""), text.replace(/es$/, "")]) {
      if (/^-?\d+$/.test(t)) return parseInt(t, 10);
      const n = wordsToInt(t);
      if (!Number.isNaN(n)) return n;
    }
    return NaN;
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function escape(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  }

  // Playing cards ------------------------------------------------------------

  const SUITS = ["hearts", "diamonds", "clubs", "spades"];
  const SUIT_SYMBOL = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const RANK_NAME = { A: "Ace", J: "Jack", Q: "Queen", K: "King" };
  const RANK_WORDS = { ace: "A", jack: "J", queen: "Q", king: "K", one: "A", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", "1": "A", "11": "J", "12": "Q", "13": "K" };

  function deck() {
    const cards = [];
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit });
    return shuffle(cards);
  }

  /** "8♥" - the short form the companion reads. */
  function cardText(card) { return `${card.rank}${SUIT_SYMBOL[card.suit]}`; }
  /** "8 of hearts" - spelled out, for results it might repeat aloud. */
  function cardName(card) { return `${RANK_NAME[card.rank] || card.rank} of ${card.suit}`; }

  /** {rank, suit} from "8 of hearts", "8♥", "8H", "eight hearts", "Queen of
   *  Spades", "QS"; null when it isn't a card. Suit may be missing (null). */
  function parseCard(text) {
    let s = String(text ?? "").trim().toLowerCase();
    if (!s) return null;
    let suit = null;
    for (const [name, symbol] of Object.entries(SUIT_SYMBOL)) {
      if (s.includes(symbol) || s.includes(name) || s.includes(name.slice(0, -1))) {
        suit = name;
        s = s.replace(symbol, " ").replace(name, " ").replace(name.slice(0, -1), " ");
        break;
      }
    }
    s = s.replace(/\bof\b/g, " ").replace(/\bthe\b/g, " ").trim();
    if (!suit) {
      const m = /^(10|[2-9ajqk])\s*([hdcs])$/.exec(s.replace(/\s+/g, ""));
      if (m) { suit = { h: "hearts", d: "diamonds", c: "clubs", s: "spades" }[m[2]]; s = m[1]; }
    }
    s = s.replace(/\s+/g, "");
    const rank = RANKS.find((r) => r.toLowerCase() === s) || RANK_WORDS[s];
    return rank ? { rank, suit } : null;
  }

  function cardElement(card, { hidden = false, small = false } = {}) {
    const el = document.createElement("div");
    el.className = `rx-card${hidden ? " back" : ""}${small ? " small" : ""}`;
    if (!hidden) {
      const red = card.suit === "hearts" || card.suit === "diamonds";
      el.classList.add(red ? "red" : "black");
      el.innerHTML = `<span class="corner">${card.rank}<br>${SUIT_SYMBOL[card.suit]}</span>`
        + `<span class="pip">${SUIT_SYMBOL[card.suit]}</span>`;
      el.title = cardName(card);
    }
    return el;
  }

  // Dice ----------------------------------------------------------------------

  const PIPS = { 1: [[50, 50]], 2: [[28, 28], [72, 72]], 3: [[26, 26], [50, 50], [74, 74]],
    4: [[28, 28], [72, 28], [28, 72], [72, 72]], 5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
    6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]] };

  function dieElement(value, { hidden = false, highlight = false } = {}) {
    const el = document.createElement("div");
    el.className = `rx-die${hidden ? " hidden" : ""}${highlight ? " hl" : ""}`;
    if (!hidden) {
      el.innerHTML = `<svg viewBox="0 0 100 100" aria-label="${value}">`
        + PIPS[value].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9"/>`).join("") + "</svg>";
    } else {
      el.textContent = "?";
    }
    return el;
  }

  window.RexGame = Object.assign(window.RexGame || {}, {
    create, Refuse, toInt, shuffle, escape,
    voice: { play: playVoice },   // the one voice channel (crew.js uses it too)
    sfxVolume,                    // the shared Effects volume: get() / set(v) / on(fn) → off
    SUITS, SUIT_SYMBOL, RANKS, deck, cardText, cardName, parseCard, cardElement,
    dieElement,
  });
})();
