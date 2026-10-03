/*
 * Rexclaw mini-games: animated backdrops, drawn on one canvas behind the
 * page. A game offers a few (RexGame.create({ scenes: [...] })) and the
 * player picks one from the settings menu.
 *
 *   RexGame.scenes.set("storm")    RexGame.scenes.LIST
 */
(function () {
  "use strict";
  const LIST = {
    night: "Night at sea",
    sunset: "Sunset harbour",
    storm: "Storm",
    tavern: "The tavern",
    deep: "The deep",
    dawn: "Dawn fog",
  };
  let canvas = null, g = null, scene = null, raf = 0, last = 0, W = 0, H = 0, t0 = performance.now();
  let stars = [], drops = [], motes = [], bubbles = [], fish = [], flash = 0, nextBolt = 0, shooting = null;
  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    W = canvas.width = innerWidth; H = canvas.height = innerHeight;
    stars = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.62, r: rand(0.3, 1.4), p: rand(0, 6.28) }));
    drops = Array.from({ length: 220 }, () => ({ x: Math.random() * W, y: Math.random() * H, l: rand(10, 24), v: rand(14, 22) }));
    motes = Array.from({ length: 50 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: rand(0.6, 2), v: rand(0.1, 0.4), p: rand(0, 6.28) }));
    bubbles = Array.from({ length: 50 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: rand(1.5, 6), v: rand(0.3, 1.2), p: rand(0, 6.28) }));
    fish = Array.from({ length: 7 }, () => ({ x: Math.random() * W, y: rand(H * 0.2, H * 0.8), s: rand(0.6, 1.4), v: rand(0.3, 0.9) * (Math.random() < 0.5 ? -1 : 1) }));
  }

  function sky(stops) {
    const gr = g.createLinearGradient(0, 0, 0, H);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }

  function glow(x, y, r, color) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color); gr.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /** Layers of rolling sea along the foot of the screen. */
  function sea(t, colors, height = 0.18, rough = 1) {
    colors.forEach((c, i) => {
      const base = H * (1 - height) + i * H * 0.035;
      g.fillStyle = c;
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W + 20; x += 20) {
        const y = base + Math.sin(x * 0.012 + t * (0.6 + i * 0.25) + i) * 7 * rough + Math.sin(x * 0.031 - t * 0.9) * 3 * rough;
        g.lineTo(x, y);
      }
      g.lineTo(W, H); g.fill();
    });
  }

  const DRAW = {
    night(t) {
      sky([[0, "#050b1d"], [0.6, "#13294b"], [1, "#0b2545"]]);
      for (const s of stars) { g.globalAlpha = 0.35 + 0.35 * Math.sin(t * 1.5 + s.p); g.fillStyle = "#fff"; g.beginPath(); g.arc(s.x, s.y, s.r, 0, 6.28); g.fill(); }
      g.globalAlpha = 1;
      glow(W * 0.82, H * 0.13, 160, "rgba(254,243,199,.22)");
      g.fillStyle = "#fef3c7"; g.beginPath(); g.arc(W * 0.82, H * 0.13, 30, 0, 6.28); g.fill();
      if (!shooting && Math.random() < 0.002) shooting = { x: rand(0, W * 0.6), y: rand(0, H * 0.3), age: 0 };
      if (shooting) {
        shooting.age += 0.02;
        const x = shooting.x + shooting.age * 600, y = shooting.y + shooting.age * 260;
        const gr = g.createLinearGradient(x - 80, y - 35, x, y); gr.addColorStop(0, "rgba(255,255,255,0)"); gr.addColorStop(1, "rgba(255,255,255,.9)");
        g.strokeStyle = gr; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 80, y - 35); g.lineTo(x, y); g.stroke();
        if (shooting.age > 1) shooting = null;
      }
      // The moon's path on the water.
      g.fillStyle = "rgba(254,243,199,.07)"; g.fillRect(W * 0.82 - 30, H * 0.82, 60, H * 0.18);
      sea(t, ["#0b2545", "#082040", "#061a33"]);
    },
    sunset(t) {
      sky([[0, "#3b1d5e"], [0.35, "#c2410c"], [0.62, "#fb923c"], [0.75, "#fcd34d"], [1, "#7c2d12"]]);
      glow(W * 0.5, H * 0.76, 300, "rgba(253,224,71,.35)");
      g.fillStyle = "#fde68a"; g.beginPath(); g.arc(W * 0.5, H * 0.8, 60, Math.PI, 0); g.fill();
      // Gulls: little Vs drifting.
      g.strokeStyle = "rgba(30,20,40,.7)"; g.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const x = ((t * 18 + i * 260) % (W + 200)) - 100, y = H * 0.25 + i * 28 + Math.sin(t + i) * 8, w = 9 + Math.sin(t * 6 + i) * 3;
        g.beginPath(); g.moveTo(x - w, y - 4); g.quadraticCurveTo(x - w / 2, y - 8, x, y); g.quadraticCurveTo(x + w / 2, y - 8, x + w, y - 4); g.stroke();
      }
      sea(t, ["#9a3412", "#7c2d12", "#5b1a0b"], 0.2);
      for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(253,224,71,${0.2 + 0.2 * Math.sin(t * 3 + i)})`; g.fillRect(W * 0.5 + Math.sin(i * 7.3) * 90, H * 0.83 + i * 4, rand(8, 30), 2); }
    },
    storm(t) {
      sky([[0, "#0b0f19"], [0.55, "#1f2937"], [1, "#111827"]]);
      for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(55,65,81,${0.35 + i * 0.05})`; g.beginPath(); g.ellipse(((t * 12 * (i + 1)) % (W + 600)) - 300, 40 + i * 30, 260, 50, 0, 0, 6.28); g.fill(); }
      if (t > nextBolt) {
        nextBolt = t + rand(6, 14);
        flash = 1;
        setTimeout(() => window.RexGame?.sfx?.thunder?.(), rand(200, 900));
      }
      if (flash > 0) {
        g.fillStyle = `rgba(226,232,240,${flash * 0.5})`; g.fillRect(0, 0, W, H);
        if (flash > 0.8) { g.strokeStyle = "#f8fafc"; g.lineWidth = 3; g.beginPath(); let x = rand(W * 0.2, W * 0.8), y = 0; g.moveTo(x, y);
          while (y < H * 0.6) { x += rand(-40, 40); y += rand(20, 50); g.lineTo(x, y); } g.stroke(); }
        flash -= 0.04;
      }
      g.strokeStyle = "rgba(186,230,253,.35)"; g.lineWidth = 1;
      g.beginPath();
      for (const d of drops) { d.y += d.v; d.x -= d.v * 0.3; if (d.y > H) { d.y = -20; d.x = Math.random() * W * 1.3; } g.moveTo(d.x, d.y); g.lineTo(d.x - d.l * 0.3, d.y + d.l); }
      g.stroke();
      sea(t * 1.6, ["#1e293b", "#172033", "#0f172a"], 0.22, 2.4);
    },
    tavern(t) {
      sky([[0, "#2a160b"], [1, "#160b05"]]);
      for (let x = 0; x < W; x += 70) { g.fillStyle = (x / 70) % 2 ? "rgba(92,51,23,.35)" : "rgba(70,38,16,.35)"; g.fillRect(x, 0, 68, H); g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(x + 68, 0, 2, H); }
      [[0.12, 0.2], [0.88, 0.25], [0.5, 0.08]].forEach(([fx, fy], i) => {
        const flick = 0.85 + 0.15 * Math.sin(t * 9 + i * 2) * Math.sin(t * 13 + i);
        glow(W * fx, H * fy, 260 * flick, `rgba(251,191,36,${0.28 * flick})`);
        g.fillStyle = "#fbbf24"; g.beginPath(); g.arc(W * fx, H * fy, 7 * flick, 0, 6.28); g.fill();
        g.strokeStyle = "rgba(0,0,0,.6)"; g.lineWidth = 2; g.beginPath(); g.moveTo(W * fx, 0); g.lineTo(W * fx, H * fy - 12); g.stroke();
      });
      for (const m of motes) { m.y -= m.v; m.x += Math.sin(t + m.p) * 0.3; if (m.y < 0) m.y = H; g.fillStyle = "rgba(253,230,138,.35)"; g.beginPath(); g.arc(m.x, m.y, m.r, 0, 6.28); g.fill(); }
      const fl = g.createLinearGradient(0, H * 0.85, 0, H); fl.addColorStop(0, "#3b2010"); fl.addColorStop(1, "#1c0f07");
      g.fillStyle = fl; g.fillRect(0, H * 0.85, W, H * 0.15);
    },
    deep(t) {
      sky([[0, "#0e7490"], [0.4, "#0c4a6e"], [1, "#020617"]]);
      g.save(); g.globalCompositeOperation = "lighter";
      for (let i = 0; i < 7; i++) {
        const x = W * (0.1 + i * 0.14) + Math.sin(t * 0.3 + i) * 40;
        const gr = g.createLinearGradient(x, 0, x + 120, H); gr.addColorStop(0, "rgba(186,230,253,.12)"); gr.addColorStop(1, "rgba(186,230,253,0)");
        g.fillStyle = gr; g.beginPath(); g.moveTo(x - 20, 0); g.lineTo(x + 40, 0); g.lineTo(x + 200, H); g.lineTo(x + 80, H); g.fill();
      }
      g.restore();
      for (const f of fish) {
        f.x += f.v; if (f.x > W + 60) f.x = -60; if (f.x < -60) f.x = W + 60;
        const dir = Math.sign(f.v), y = f.y + Math.sin(t + f.x * 0.01) * 6;
        g.fillStyle = "rgba(2,6,23,.55)"; g.beginPath(); g.ellipse(f.x, y, 18 * f.s, 7 * f.s, 0, 0, 6.28); g.fill();
        g.beginPath(); g.moveTo(f.x - dir * 16 * f.s, y); g.lineTo(f.x - dir * 28 * f.s, y - 8 * f.s); g.lineTo(f.x - dir * 28 * f.s, y + 8 * f.s); g.fill();
      }
      g.strokeStyle = "rgba(224,242,254,.5)"; g.lineWidth = 1;
      for (const b of bubbles) { b.y -= b.v; b.x += Math.sin(t * 2 + b.p) * 0.4; if (b.y < -10) { b.y = H + 10; b.x = Math.random() * W; } g.beginPath(); g.arc(b.x, b.y, b.r, 0, 6.28); g.stroke(); }
      // Kelp swaying from the floor.
      g.strokeStyle = "rgba(21,128,61,.5)"; g.lineWidth = 5;
      for (let i = 0; i < 9; i++) { const x = (i + 0.5) * W / 9; g.beginPath(); g.moveTo(x, H);
        for (let y = 0; y < 160; y += 16) g.lineTo(x + Math.sin(t + y * 0.04 + i) * (y * 0.15), H - y); g.stroke(); }
    },
    dawn(t) {
      sky([[0, "#a5b4fc"], [0.45, "#fbcfe8"], [0.7, "#fed7aa"], [1, "#94a3b8"]]);
      glow(W * 0.25, H * 0.7, 220, "rgba(255,237,213,.6)");
      for (let i = 0; i < 4; i++) { g.fillStyle = `rgba(241,245,249,${0.18 + i * 0.05})`;
        g.fillRect(((t * (8 + i * 4)) % (W + 400)) - 400 + i * 120, H * (0.5 + i * 0.07), W * 0.9, 26 + i * 6); }
      sea(t * 0.6, ["#94a3b8", "#64748b", "#475569"], 0.2, 0.6);
    },
  };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;          // ~30 fps is plenty for a backdrop
    last = now;
    DRAW[scene]?.((now - t0) / 1000);
  }

  function set(id) {
    if (!DRAW[id]) return;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "rxk-scene";
      document.body.prepend(canvas);
      g = canvas.getContext("2d");
      addEventListener("resize", resize);
      resize();
      raf = requestAnimationFrame(frame);
    }
    scene = id;
    nextBolt = (performance.now() - t0) / 1000 + 3;
  }

  window.RexGame = Object.assign(window.RexGame || {}, { scenes: { LIST, set, current: () => scene } });
})();
