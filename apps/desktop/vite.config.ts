import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Phase 4.2 populates packages/shared; this alias lets Vite bundle its TS
      // source directly, no separate build step.
      "@atba3li/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    allowedHosts: true,
    proxy: {
      // Proxy target is env-configurable so both dev flows work:
      //   - `npm run electron:dev`: Electron embeds the server on 47821.
      //   - `npm run dev` (browser-only): standalone `node server.js` on 3001.
      // The plain-node flow only works with a Node-ABI build of better-sqlite3
      // (`npm run rebuild:node`) — Electron's postinstall rebuilds for Electron.
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:3001",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") return;
            console.error("proxy error", err);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    // "hidden" still emits maps for crash triage but keeps the //# sourceMappingURL
    // comment out of the shipped bundle, so browsers never fetch the 4.8MB file.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Split the rarely-changing vendor code out of the app chunk so a UI
        // tweak doesn't invalidate 1MB+ of cached React/Radix on every release.
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-radix": [
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-label",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
            "@radix-ui/react-switch",
            "@radix-ui/react-toast",
          ],
        },
      },
    },
  },
});
