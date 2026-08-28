// @localprint/shared
//
// Phase 4.2 relocates the deduplicated modules here — each as its own module
// re-exported below. Both apps import them via the "@localprint/shared"
// specifier (mapped to ./src in each app's tsconfig paths + vite alias).
export * from "./types";
export * from "./utils";
