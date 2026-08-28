import { defineConfig } from "vitest/config";

// Isolated from vite.config.ts (no react plugin / dev proxy) — the safety-net
// suite is pure Node logic: pricing, validation, pdf page-count, token prune.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
