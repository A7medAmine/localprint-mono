import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
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
            if ((err as any).code === "ECONNREFUSED") return;
            console.error("proxy error", err);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
