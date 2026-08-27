// Shared pdf.js worker setup.
//
// The worker source is patched on disk with a Uint8Array.prototype.toHex
// polyfill by scripts/patch-pdfjs-worker.js (postinstall). See that script
// for the full "why" — Electron 33's Chromium 130 doesn't ship toHex yet
// and pdf.js v5 calls it, and the on-disk patch is the only place it
// works without breaking pdf.js's internal WASM fetches.
//
// This module exists to keep every pdf.js entry point (Studio thumbnails,
// preview modal) pointed at the same worker URL — Vite's `?url` handling
// gives us a hashed asset URL in prod and a dev-served path in dev.

import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Defensive main-thread polyfills — pdf.js v5 targets Chromium 131+ and
// calls Uint8Array#toHex (TC39 stage-3) plus Map#getOrInsertComputed (TC39
// stage-3, Chromium 133+). Electron 33 runs Chromium 130 and blows up
// with "getOrInsertComputed is not a function" on the main thread's
// rendering path. Mirror the worker patch here — see
// scripts/patch-pdfjs-worker.js for the full rationale.
if (typeof Uint8Array.prototype.toHex !== "function") {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value: function toHex(this: Uint8Array) {
      let s = "";
      for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, "0");
      return s;
    },
    writable: true,
    configurable: true,
  });
}

type MapLike<K, V> = { has(k: K): boolean; get(k: K): V | undefined; set(k: K, v: V): unknown };

function installGetOrInsert(proto: MapLike<any, any>) {
  if (typeof (proto as any).getOrInsert !== "function") {
    Object.defineProperty(proto, "getOrInsert", {
      value: function <K, V>(this: MapLike<K, V>, key: K, value: V) {
        if (this.has(key)) return this.get(key)!;
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof (proto as any).getOrInsertComputed !== "function") {
    Object.defineProperty(proto, "getOrInsertComputed", {
      value: function <K, V>(this: MapLike<K, V>, key: K, fn: (k: K) => V) {
        if (this.has(key)) return this.get(key)!;
        const value = fn(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
    });
  }
}

installGetOrInsert(Map.prototype as any);
installGetOrInsert(WeakMap.prototype as any);

export function getPdfWorkerUrl(): string {
  return pdfWorkerUrl;
}
