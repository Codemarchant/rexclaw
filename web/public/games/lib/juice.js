/*
 * Rexclaw mini-games: the juice. Sound effects synthesised on the spot with
 * Web Audio (no files, nothing to license), plus confetti, floating score
 * pops and screen shake. Loaded by every game page after neuro.js; adds
 * RexGame.sfx and RexGame.fx.
 */
(function () {
  "use strict";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---- Sound ---------------------------------------------------------------

  let ctx = null, master = null;
  let muted = store.get("rx-games-mute") === "1";
  // The kit's Effects volume (neuro.js, the ⚙ menu's slider) scales the bus; 1 = the games' old level.
  const LEVEL = 0.55;
  const volume = () => { const v = Number(window.RexGame?.sfxVolume?.get?.()); return Number.isFinite(v) ? v : 1; };
  window.RexGame?.sfxVolume?.on?.((v) => { if (master && ctx) master.gain.setTargetAtTime(LEVEL * v, ctx.currentTime, 0.03); });

  function ac() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      master = ctx.createGain();
      master.gain.value = LEVEL * volume();
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  // Browsers start audio only after a gesture: wake it on the first one.
  for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => ac(), { once: true, capture: true });

  /** One oscillator note. slide: semitones to glide by over the note. */
  function tone({ freq = 440, type = "sine", dur = 0.15, vol = 0.25, slide = 0, delay = 0, attack = 0.005 }) {
    const c = ac(); if (!c || muted) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * 2 ** (slide / 12), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  let noiseBuf = null;
  /** Filtered white noise: shuffles, rattles, splashes, whooshes. */
  function noise({ dur = 0.1, vol = 0.2, type = "bandpass", freq = 2000, q = 1, delay = 0, sweep = 0 }) {
    const c = ac(); if (!c || muted) return;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + delay;
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noiseBuf;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 2 ** (sweep / 12)), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }

  const notes = (list, { type = "square", vol = 0.12, step = 0.09, dur = 0.16 } = {}) =>
    list.forEach((f, i) => tone({ freq: f, type, vol, dur, delay: i * step }));

  const sfx = {
    click: () => tone({ freq: 1100, type: "square", dur: 0.035, vol: 0.05 }),
    hover: () => tone({ freq: 1800, type: "sine", dur: 0.03, vol: 0.03 }),
    pop: () => tone({ freq: 520, slide: 14, dur: 0.09, vol: 0.18 }),
    drop: () => { tone({ freq: 300, slide: -10, dur: 0.16, type: "triangle", vol: 0.28 }); noise({ dur: 0.05, vol: 0.12, freq: 2500 }); },
    clink: () => { tone({ freq: 1568, dur: 0.12, vol: 0.12, type: "triangle" }); tone({ freq: 2349, dur: 0.18, vol: 0.06, delay: 0.03 }); },
    coin: () => { tone({ freq: 988, type: "square", dur: 0.06, vol: 0.09 }); tone({ freq: 1319, type: "square", dur: 0.22, vol: 0.09, delay: 0.06 }); },
    coins: (n = 5) => { for (let i = 0; i < n; i++) tone({ freq: 1200 + Math.random() * 900, type: "triangle", dur: 0.08, vol: 0.06, delay: i * 0.05 }); },
    card: () => noise({ dur: 0.09, vol: 0.22, freq: 3200, q: 0.7, sweep: -8 }),
    shuffle: () => { for (let i = 0; i < 8; i++) noise({ dur: 0.05, vol: 0.12, freq: 2600 + i * 120, q: 0.8, delay: i * 0.04 }); },
    dice: () => { for (let i = 0; i < 7; i++) noise({ dur: 0.04, vol: 0.18, type: "highpass", freq: 1800 + Math.random() * 1500, delay: i * 0.045 + Math.random() * 0.02 }); },
    whoosh: () => noise({ dur: 0.35, vol: 0.18, freq: 400, q: 0.6, sweep: 24 }),
    splash: () => { noise({ dur: 0.7, vol: 0.35, type: "lowpass", freq: 1800, sweep: -20 }); noise({ dur: 0.3, vol: 0.15, freq: 4000, delay: 0.05 }); },
    tick: () => tone({ freq: 1600, type: "square", dur: 0.025, vol: 0.05 }),
    alarm: () => notes([880, 660, 880, 660], { vol: 0.08, step: 0.12, dur: 0.1 }),
    error: () => tone({ freq: 140, type: "square", dur: 0.18, vol: 0.08 }),
    bubble: () => { tone({ freq: 660, slide: 7, dur: 0.07, vol: 0.08 }); tone({ freq: 990, dur: 0.08, vol: 0.06, delay: 0.06 }); },
    /** Rising with the streak: every pop in a run lands a little higher. */
    combo: (n = 1) => { const f = 523 * 2 ** (Math.min(n, 12) / 12); tone({ freq: f, type: "square", dur: 0.09, vol: 0.1 }); tone({ freq: f * 1.5, type: "square", dur: 0.14, vol: 0.07, delay: 0.07 }); },
    win: () => { notes([523, 659, 784, 1047], { step: 0.1 }); notes([784, 1047, 1319], { vol: 0.08, step: 0.07, dur: 0.3, type: "triangle" }); setTimeout(() => sfx.coins(8), 450); },
    jackpot: () => { notes([523, 659, 784, 1047, 1319, 1568, 2093], { step: 0.06, vol: 0.1 }); setTimeout(() => sfx.coins(14), 420); },
    lose: () => [392, 370, 349, 294].forEach((f, i) => tone({ freq: f, type: "sawtooth", dur: i === 3 ? 0.7 : 0.28, vol: 0.07, slide: i === 3 ? -3 : 0, delay: i * 0.28 })),
    draw: () => notes([523, 523], { type: "triangle", step: 0.15, vol: 0.1 }),
    fanfare: () => notes([392, 392, 392, 523], { step: 0.13, dur: 0.18, vol: 0.1 }),
    bell: () => { tone({ freq: 1320, dur: 1.2, vol: 0.12, type: "sine" }); tone({ freq: 2640, dur: 0.8, vol: 0.04 }); },
    /** A cannon: a thump, a crack and the rumble after. */
    cannon: () => {
      tone({ freq: 90, slide: -18, dur: 0.5, type: "sine", vol: 0.5 });
      noise({ dur: 0.12, vol: 0.5, type: "lowpass", freq: 3000 });
      noise({ dur: 1.1, vol: 0.25, type: "lowpass", freq: 600, sweep: -18, delay: 0.05 });
    },
    boom: () => { tone({ freq: 60, slide: -12, dur: 0.9, vol: 0.45 }); noise({ dur: 1.4, vol: 0.35, type: "lowpass", freq: 900, sweep: -24 }); },
    thunder: () => { noise({ dur: 2.4, vol: 0.4, type: "lowpass", freq: 300, sweep: -10 }); noise({ dur: 0.3, vol: 0.3, type: "lowpass", freq: 1500, delay: 0.05 }); },
    /** A seagull's "kyow": a squeal bending down, twice. */
    gull: () => [0, 0.22].forEach((d) => { tone({ freq: 1900, slide: -9, dur: 0.18, type: "sawtooth", vol: 0.05, delay: d }); tone({ freq: 2850, slide: -9, dur: 0.16, type: "sine", vol: 0.04, delay: d }); }),
    parrot: () => [0, 0.12, 0.2].forEach((d, i) => tone({ freq: 1400 + i * 300, slide: i === 2 ? 8 : -5, dur: 0.1, type: "sawtooth", vol: 0.05, delay: d })),
    /** The Kraken clears its throat. */
    roar: () => { tone({ freq: 70, slide: -5, dur: 1.2, type: "sawtooth", vol: 0.18 }); tone({ freq: 104, slide: -7, dur: 1.1, type: "square", vol: 0.06 }); noise({ dur: 1.2, vol: 0.12, type: "lowpass", freq: 400 }); },
    clang: () => { [1200, 1810, 2390, 3150].forEach((f, i) => tone({ freq: f, dur: 0.5 - i * 0.08, vol: 0.06, type: "triangle" })); noise({ dur: 0.04, vol: 0.2, type: "highpass", freq: 4000 }); },
    chomp: () => { noise({ dur: 0.08, vol: 0.3, type: "lowpass", freq: 900 }); noise({ dur: 0.08, vol: 0.3, type: "lowpass", freq: 700, delay: 0.14 }); tone({ freq: 120, slide: -6, dur: 0.2, vol: 0.2, delay: 0.14 }); },
    creak: () => { const c = ac(); if (!c || muted) return; tone({ freq: 160, slide: 5, dur: 0.6, type: "sawtooth", vol: 0.03 }); noise({ dur: 0.6, vol: 0.06, freq: 500, q: 8, sweep: 6 }); },
    cash: () => { notes([1568, 2093], { step: 0.07, vol: 0.08, type: "triangle", dur: 0.12 }); tone({ freq: 3136, dur: 0.6, vol: 0.05, delay: 0.14 }); },
    rimshot: () => { noise({ dur: 0.08, vol: 0.25, freq: 2500, q: 2 }); tone({ freq: 330, dur: 0.06, vol: 0.12, delay: 0.25, type: "triangle" }); noise({ dur: 0.5, vol: 0.12, type: "highpass", freq: 6000, delay: 0.45 }); },
    sparkle: () => notes([1568, 1976, 2349, 3136], { type: "sine", step: 0.05, vol: 0.06, dur: 0.25 }),
    // The visitors: a cork, a cat, a tentacle.
    cork: () => { tone({ freq: 420, slide: 12, dur: 0.06, vol: 0.18 }); noise({ dur: 0.05, vol: 0.15, freq: 3000, delay: 0.02 }); },
    purr: () => { for (let i = 0; i < 7; i++) noise({ dur: 0.12, vol: 0.14, type: "lowpass", freq: 240, q: 3, delay: i * 0.13 }); },
    meow: () => { tone({ freq: 620, slide: 5, dur: 0.16, type: "triangle", vol: 0.07, attack: 0.03 }); tone({ freq: 830, slide: -9, dur: 0.38, type: "triangle", vol: 0.06, delay: 0.14 }); },
    squelch: () => { noise({ dur: 0.4, vol: 0.25, type: "lowpass", freq: 420, q: 5, sweep: 12 }); tone({ freq: 85, slide: 7, dur: 0.35, type: "sawtooth", vol: 0.06 }); },
  };

  sfx.muted = () => muted;
  sfx.setMuted = (on) => { muted = !!on; store.set("rx-games-mute", muted ? "1" : "0"); };
  /** The shared AudioContext (music.js plays through it too). */
  sfx.context = () => ac();

  // ---- Effects ---------------------------------------------------------------

  const COLORS = ["#facc15", "#f472b6", "#38bdf8", "#4ade80", "#fb923c", "#a78bfa", "#ef4444"];

  /** Confetti (and the odd doubloon) over the whole page for ~3 s. */
  function confetti({ count = 140, coins = false } = {}) {
    const cv = document.createElement("canvas");
    cv.className = "rx-confetti";
    cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
    document.body.appendChild(cv);
    const g = cv.getContext("2d");
    g.scale(devicePixelRatio, devicePixelRatio);
    const parts = Array.from({ length: count }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.3, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: COLORS[(Math.random() * COLORS.length) | 0],
      coin: coins && Math.random() < 0.35,
    }));
    const t0 = performance.now();
    (function frame(t) {
      const age = (t - t0) / 1000;
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.globalAlpha = Math.max(0, 1 - age / 3.2);
        if (p.coin) {
          g.fillStyle = "#facc15"; g.beginPath(); g.ellipse(0, 0, 8, 8 * Math.abs(Math.cos(p.r)), 0, 0, 6.28); g.fill();
          g.strokeStyle = "#a16207"; g.lineWidth = 1.5; g.stroke();
        } else { g.fillStyle = p.c; g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
        g.restore();
      }
      if (age < 3.3) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  }

  /** "+50" rising from an element (or the middle of the screen). */
  function float(text, { at = null, color = "#facc15", big = false } = {}) {
    const el = document.createElement("div");
    el.className = `rx-float${big ? " big" : ""}`;
    el.textContent = text;
    el.style.color = color;
    const r = at?.getBoundingClientRect?.();
    el.style.left = `${r ? r.left + r.width / 2 : innerWidth / 2}px`;
    el.style.top = `${r ? r.top + r.height / 2 : innerHeight * 0.4}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  function shake(el = document.querySelector("main")) {
    if (!el) return;
    el.classList.remove("rx-shake"); void el.offsetWidth; el.classList.add("rx-shake");
  }

  function flash(color = "rgba(250,204,21,.25)") {
    const el = document.createElement("div");
    el.className = "rx-flash"; el.style.background = color;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  /** A seagull flaps across the screen. Bonk it for `onBonk` (doubloons). */
  function seagull(onBonk) {
    const el = document.createElement("div");
    el.className = "rxk-gull";
    el.style.top = `${8 + Math.random() * 30}vh`;
    el.innerHTML = '<svg viewBox="0 0 64 40"><g class="wing"><path d="M32 20 Q20 4 4 10 Q18 12 30 22Z" fill="#f8fafc"/><path d="M32 20 Q44 4 60 10 Q46 12 34 22Z" fill="#e2e8f0"/></g>'
      + '<ellipse cx="32" cy="22" rx="9" ry="5" fill="#f8fafc"/><circle cx="40" cy="20" r="3.5" fill="#f8fafc"/><path d="M43 20 l6 1.5 -6 1z" fill="#f59e0b"/><circle cx="41" cy="19" r=".9" fill="#0f172a"/></svg>';
    el.onclick = () => {
      if (el.classList.contains("hit")) return;
      el.classList.add("hit");
      sfx.gull(); sfx.rimshot();
      float("Bonk!", { at: el, color: "#f8fafc" });
      onBonk?.(el);
    };
    document.body.appendChild(el);
    sfx.gull();
    setTimeout(() => el.remove(), 9500);
  }

  // ---- Visitors: rarer than the gulls (neuro.js picks one now and then) --------

  /** Put a visitor on screen; it leaves by itself after `life` ms. */
  function visitor(className, svg, title, life) {
    const el = document.createElement("div");
    el.className = className;
    el.title = title;
    el.innerHTML = svg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), life);
    return el;
  }

  /** A message in a bottle bobs past. Open it for `onOpen` (it reads out
   *  with scroll()). */
  function bottle(onOpen) {
    const el = visitor("rxk-bottle", '<svg viewBox="0 0 80 34">'
      + '<path d="M6 9h38a11 11 0 0 1 11 8 11 11 0 0 1-11 8H6a5 5 0 0 1-5-5v-6a5 5 0 0 1 5-5z" fill="#86efac44" stroke="#bbf7d0" stroke-width="2"/>'
      + '<path d="M55 13h12v8H55z" fill="#86efac44" stroke="#bbf7d0" stroke-width="2"/><rect x="67" y="12" width="9" height="10" rx="2" fill="#b45309"/>'
      + '<rect x="11" y="13" width="31" height="8" rx="4" fill="#fef3c7" stroke="#d6b77a"/></svg>', "A message in a bottle", 16000);
    el.onclick = () => {
      if (el.classList.contains("hit")) return;
      el.classList.add("hit");
      sfx.cork(); sfx.splash();
      onOpen?.(el);
    };
    sfx.splash();
  }

  /** A note on parchment, unrolled mid-screen for a few seconds. */
  function scroll(text, signed = "- the Captain") {
    document.querySelector(".rxk-scroll")?.remove();
    const el = document.createElement("div");
    el.className = "rxk-scroll";
    el.innerHTML = `<p></p><small></small>`;
    el.querySelector("p").textContent = text;
    el.querySelector("small").textContent = signed;
    el.onclick = () => el.remove();
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500 + text.length * 45);
  }

  /** Evie the cat strolls along the bottom of the screen. Pet her for `onPet`. */
  function cat(onPet) {
    const el = visitor("rxk-cat", '<svg viewBox="0 0 80 50">'
      + '<path class="tail" d="M14 31 Q3 24 7 10" fill="none" stroke="#475569" stroke-width="4" stroke-linecap="round"/>'
      + '<path d="M20 40v8M28 41v7M42 41v7M50 40v8" stroke="#475569" stroke-width="4" stroke-linecap="round"/>'
      + '<ellipse cx="34" cy="32" rx="22" ry="10" fill="#475569"/><circle cx="60" cy="24" r="10" fill="#475569"/>'
      + '<path d="M53 17 L55 6 L60 15 Z M62 15 L67 6 L68 18 Z" fill="#475569"/>'
      + '<circle cx="57" cy="23" r="1.7" fill="#facc15"/><circle cx="64" cy="23" r="1.7" fill="#facc15"/>'
      + '<path d="M60 28 l-1.5 1.5 M60 28 l1.5 1.5" stroke="#cbd5e1" stroke-width="1"/></svg>', "Evie the cat", 14000);
    // Petted: she stops for a purr, then strolls on (once per visit).
    el.onclick = () => {
      if (el.classList.contains("petted")) return;
      el.classList.add("pet", "petted");
      sfx.purr(); setTimeout(() => sfx.meow(), 900);
      setTimeout(() => el.classList.remove("pet"), 1800);
      onPet?.(el);
    };
    setTimeout(() => sfx.meow(), 1200);
  }

  /** The Kraken's tentacle creeps up a corner. Shoo it (click) within
   *  `wait` ms for `onShoo`; otherwise it takes something (`onTake`). */
  function tentacle(onShoo, onTake, wait = 4500) {
    const el = visitor("rxk-tentacle", '<svg viewBox="0 0 60 160">'
      + '<path d="M22 160 C8 120 38 100 24 70 C12 44 34 26 28 8 C27 2 35 1 36 8 C41 30 23 46 35 70 C49 98 21 122 40 160Z" fill="#7c3aed" stroke="#4c1d95" stroke-width="2"/>'
      + '<g fill="#ddd6fe"><circle cx="27" cy="120" r="3"/><circle cx="29" cy="96" r="2.6"/><circle cx="28" cy="72" r="2.3"/>'
      + '<circle cx="30" cy="50" r="2"/><circle cx="31" cy="30" r="1.6"/></g></svg>', "The Kraken! Shoo it!", wait + 2500);
    let done = false;
    sfx.squelch();
    el.onclick = () => {
      if (done) return;
      done = true;
      el.classList.add("shooed");
      sfx.clang(); sfx.splash();
      float("Shoo!", { at: el, color: "#ddd6fe", big: true });
      onShoo?.(el);
    };
    setTimeout(() => {
      if (done) return;
      done = true;
      el.classList.add("grab");
      sfx.chomp(); sfx.splash();
      onTake?.(el);
    }, wait);
  }

  window.RexGame = Object.assign(window.RexGame || {}, { sfx, fx: { confetti, float, shake, flash, seagull, bottle, scroll, cat, tentacle } });
})();
