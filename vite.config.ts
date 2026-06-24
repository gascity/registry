import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build-time mount prefix, exactly like the sibling SPAs (BEADS_WEB_BASE etc.).
// Default "/" = the standalone build (registry.gascity.com + the CLI contract);
// "/registry/" = the apex-panel build, framed at works.gascity.com/registry/.
// Vite uses `base` to (a) rewrite built asset URLs under the prefix and (b) set
// import.meta.env.BASE_URL (the source of MOUNT_BASE in src/lib/base.ts).
const base = process.env.REGISTRY_WEB_BASE || "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.REGISTRY_API_URL ?? "http://127.0.0.1:8081",
        changeOrigin: false,
      },
      "/catalog.json": {
        target: process.env.REGISTRY_API_URL ?? "http://127.0.0.1:8081",
        changeOrigin: false,
      },
      "/registry.toml": {
        target: process.env.REGISTRY_API_URL ?? "http://127.0.0.1:8081",
        changeOrigin: false,
      },
    },
  },
});
