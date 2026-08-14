import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite owns the page, FastAPI (port 8990) owns /api, /assets and /files.
// Prod: `vite build` emits dist/ with hashed bundles under app-assets/ —
// renamed from Vite's default `assets/` so they don't collide with the
// FastAPI /assets mount (bundled VRM/VRMA/GLB files).
export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: "app-assets",
  },
  server: {
    port: 5990,
    proxy: {
      "/api": "http://127.0.0.1:8990",
      "/assets": "http://127.0.0.1:8990",
      "/files": "http://127.0.0.1:8990",
      "/user-assets": "http://127.0.0.1:8990",
      "/avatars": "http://127.0.0.1:8990",
    },
  },
});
