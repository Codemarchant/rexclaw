import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

// The mini-games (public/games/) load three.js as a plain module, not through
// the app's bundle: copy the app's own build and its addons next to them, so a
// 3D game works offline and on the same version. The addons' libs/ (Draco,
// Basis and other decoders, 9 MB) stay out. three-vrm and its animation
// plugin come too (ES builds that import only "three", MIT, banner kept),
// for games that put the companion's own VRM on stage (Night Raid).
function gamesVendor() {
  return {
    name: "rexclaw-games-vendor",
    apply: "build",
    closeBundle() {
      const three = join(here, "node_modules", "three");
      const out = join(here, "dist", "games", "lib", "vendor", "three");
      mkdirSync(out, { recursive: true });
      for (const file of ["three.module.min.js", "three.core.min.js"]) {
        cpSync(join(three, "build", file), join(out, file));
      }
      cpSync(join(three, "examples", "jsm"), join(out, "addons"), {
        recursive: true,
        filter: (src) => !/[\\/]jsm[\\/]libs([\\/]|$)/.test(src),
      });
      const vrmOut = join(here, "dist", "games", "lib", "vendor", "three-vrm");
      mkdirSync(vrmOut, { recursive: true });
      cpSync(join(here, "node_modules", "@pixiv", "three-vrm", "lib", "three-vrm.module.min.js"), join(vrmOut, "three-vrm.module.min.js"));
      cpSync(join(here, "node_modules", "@pixiv", "three-vrm-animation", "lib", "three-vrm-animation.module.min.js"), join(vrmOut, "three-vrm-animation.module.min.js"));
      cpSync(join(here, "node_modules", "@pixiv", "three-vrm", "LICENSE"), join(vrmOut, "LICENSE"));
    },
  };
}

// MediaPipe tasks-vision (Apache-2.0) posts usage metrics — which task ran,
// how long it took — to Google's logging endpoint every 60 s, with no
// option to switch it off (its README's privacy notice). Camera awareness
// promises that nothing leaves the device, so the endpoint is pointed at
// about:blank in our copy: the first flush fails locally, and its logger
// then stops for good (it gives up on any send error — fetch rejects
// about:blank before any network is touched). Camera frames and landmarks
// were never part of it. The app bundle and the dev server's pre-bundle
// (a Web Worker importing tasks-vision would need the plugin in
// `worker.plugins` too — Vite builds workers separately). The /*! notice
// survives minification (Apache-2.0 §4(b): changed files say so).
// Re-check after a tasks-vision upgrade: grep dist/ for "odml".
const MP_METRICS_URL = "https://odml.pa.googleapis.com/v1/log";
const MP_NOTICE = "/*! @mediapipe/tasks-vision, modified by Rexclaw: usage-metrics endpoint disabled. */\n";
const noMediapipeMetrics = (code) => code.includes(MP_METRICS_URL)
  ? MP_NOTICE + code.split(MP_METRICS_URL).join("about:blank")
  : null;

function mediapipeNoMetrics() {
  return {
    name: "rexclaw-mediapipe-no-metrics",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@mediapipe/tasks-vision")) return null;
      const out = noMediapipeMetrics(code);
      return out ? { code: out, map: null } : null;
    },
  };
}

// Dev: Vite owns the page, FastAPI (port 8990) owns /api, /assets and /files.
// Prod: `vite build` emits dist/ with hashed bundles under app-assets/ —
// renamed from Vite's default `assets/` so they don't collide with the
// FastAPI /assets mount (bundled VRM/VRMA/GLB files).
export default defineConfig({
  plugins: [mediapipeNoMetrics(), react(), gamesVendor()],
  build: {
    assetsDir: "app-assets",
  },
  // These find their decoders (three/examples/jsm/libs/) next to themselves
  // via import.meta.url; pre-bundled into .vite/deps, that path 404s in dev.
  optimizeDeps: {
    exclude: [
      "three/examples/jsm/loaders/DRACOLoader.js",
      "three/examples/jsm/loaders/KTX2Loader.js",
    ],
    esbuildOptions: {
      plugins: [{
        name: "rexclaw-mediapipe-no-metrics",
        setup(b) {
          b.onLoad({ filter: /@mediapipe[\\/]tasks-vision[\\/].*\.m?js$/ }, async (args) => {
            const { readFile } = await import("node:fs/promises");
            const code = await readFile(args.path, "utf8");
            return { contents: noMediapipeMetrics(code) ?? code, loader: "js" };
          });
        },
      }],
    },
  },
  server: {
    port: 5990,
    proxy: {
      // ws: the pipeline voice engine's call socket lives under /api too.
      "/api": { target: "http://127.0.0.1:8990", ws: true },
      "/assets": "http://127.0.0.1:8990",
      "/files": "http://127.0.0.1:8990",
      "/user-assets": "http://127.0.0.1:8990",
      "/avatars": "http://127.0.0.1:8990",
    },
  },
});
