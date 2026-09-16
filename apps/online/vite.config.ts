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
    port: 5000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:5001",
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
    // Maps are still emitted for triage, but without the sourceMappingURL
    // comment that makes every browser download them.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Auth state is needed at app start, so this can't be deferred — but
          // isolating it keeps a UI release from invalidating 200KB of cache.
          "vendor-supabase": ["@supabase/supabase-js"],
        },
      },
    },
  },
});
