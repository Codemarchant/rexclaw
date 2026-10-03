import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

// The mini-games (public/games/) load three.js as a plain module, not through
// the app's bundle: copy the app's own build and its addons next to them, so a
// 3D game works offline and on the same version. The addons' libs/ (Draco,
// Basis and other decoders, 9 MB) stay out.
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
    },
  };
}

// Dev: Vite owns the page, FastAPI (port 8990) owns /api, /assets and /files.
// Prod: `vite build` emits dist/ with hashed bundles under app-assets/ —
// renamed from Vite's default `assets/` so they don't collide with the
// FastAPI /assets mount (bundled VRM/VRMA/GLB files).
export default defineConfig({
  plugins: [react(), gamesVendor()],
  build: {
    assetsDir: "app-assets",
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
