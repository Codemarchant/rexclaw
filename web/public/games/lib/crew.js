/*
 * Rexclaw mini-games: the Rexmaw crew's cameos. Rex, Eve, Ara, Sal and Leo
 * chime in from around the ship with lines recorded in their own voices
 * (crew/lines.json, baked by tools/games/bake_crew_voices.py). They play
 * whoever you're playing with - except that your opponent never heckles
 * themselves from the gallery.
 *
 *   RexGame.crew.heckle("user_win", { game: "Blackjack", exclude: "Rex", chance: 0.6 })
 *
 * Events: start, user_win, user_loss, draw, seagull, close_call, plus each
 * game's own (deal, bust, blackjack, reveal, splash, kraken, block, shoot,
 * fire, hit, miss, hurt, sink, check, castle, kraken_taken, promote, en_passant,
 * all_in, showdown, river, bad_beat, bluff_shown, hero_call, polly, blunder,
 * rampage; Rexmaw Raids' cast_off, contact, board, won, lost, striking, sink,
 * brace, bank, dawn, caught_dawn, we_sink, man_overboard, overboard_rescued,
 * fire_aboard, fire_out, leak_patched, pumps_holding, hazard_wave, hazard_shoal,
 * hazard_maelstrom, kraken, legendary, fort, ack_round, ack_chain, ack_grape,
 * ack_heavy, fire_bears, order_mark, order_hold, order_raking, volley_mark,
 * moment_shanty, moment_tea, moment_banter, moment_rally, moment_joke,
 * mission_day, mission_night, mission_success, mission_fail, day_ending,
 * fort, tower_down, iron_duke, chain_hit, sprint, pickup, pickup_chest, cove,
 * reef_near, fog_heading, danger_marked, lantern, spotted, kraken_arm_off, and
 * per-speaker "<who>:<event>" forms such as leo:ack_man_guns_port or
 * ara:repair_done) and the visitors' (bottle, cat, tentacle, kraken_tax). A
 * line's optional `say` is what its voice was recorded from (with speech
 * tags); the toast shows `text`.
 */
(function () {
  "use strict";
  const here = document.currentScript?.src.replace(/[^/]*$/, "") || "/games/lib/";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let data = null, lastAt = 0, lastId = null;
  const loaded = fetch(`${here}crew/lines.json`).then((r) => r.json()).then((d) => { data = d; }).catch(() => {});

  const enabled = () => store.get("rx-games-crew") !== "0";

  /** A crew member's line for `event`, said out loud with a toast. Returns
   *  whether one played. `chance` thins them out; `minGap` (ms) keeps the
   *  gallery from talking over itself. */
  function heckle(event, { game = null, exclude = null, chance = 1, minGap = 6000 } = {}) {
    if (!data || !enabled() || Math.random() > chance || Date.now() - lastAt < minGap) return false;
    const pool = data.lines.filter((l) => l.events.includes(event) && (!l.games || l.games.includes(game))
      && l.who !== exclude && l.id !== lastId);
    if (!pool.length) return false;
    const line = pool[(Math.random() * pool.length) | 0];
    lastAt = Date.now(); lastId = line.id;
    // The kit's one voice channel: waits for a line already playing (the
    // companion's reaction, another cameo); the toast shows as it speaks.
    window.RexGame.voice.play(`${here}crew/${line.id}.mp3`, { volume: 0.9, onStart: () => toast(line) });
    return true;
  }

  function toast(line) {
    const who = data.crew[line.who];
    document.querySelector(".rxk-crew")?.remove();
    const el = document.createElement("div");
    el.className = "rxk-crew";
    const esc = window.RexGame.escape;
    el.innerHTML = (who.portrait ? `<img src="${esc(who.portrait)}" alt="" onerror="this.outerHTML='<span class=ini>${esc(line.who[0])}</span>'">` : `<span class="ini">${esc(line.who[0])}</span>`)
      + `<div><b>${esc(line.who)} <small>· ${esc(who.role)}</small></b>${esc(line.text)}</div>`;
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 450); }, 3800 + line.text.length * 25);
  }

  window.RexGame = Object.assign(window.RexGame || {}, {
    crew: { heckle, enabled, setEnabled: (on) => store.set("rx-games-crew", on ? "1" : "0"), loaded },
  });
})();
