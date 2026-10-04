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
 * rampage) and the visitors' (bottle, cat, tentacle, kraken_tax).
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
