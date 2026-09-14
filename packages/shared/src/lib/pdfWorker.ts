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
// Cast the guard so this file carries no dependency on a global
// `interface Uint8Array { toHex }` augmentation — it now compiles inside both
// apps' tsc programs (desktop declares that global, online does not).
if (typeof (Uint8Array.prototype as { toHex?: unknown }).toHex !== "function") {
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

// Uint8Array#toBase64 (TC39 stage-3, Chromium 140+). pdf.js builds the
// `url(data:font/...;base64,…)` src for every embedded font with it
// (`FontFaceObject.createNativeFontFace`). On Chromium 130 the call throws,
// the @font-face never installs, and Chrome silently falls back to a default
// font — which for an Identity-H/CID font means the glyph ids render as
// garbage. That is what makes Arabic PDFs come out with broken, disconnected
// letters in the Electron build while the same file is fine in a modern
// browser.
if (typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 !== "function") {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value: function toBase64(this: Uint8Array) {
      let out = "";
      let i = 0;
      for (; i + 2 < this.length; i += 3) {
        const n = (this[i] << 16) | (this[i + 1] << 8) | this[i + 2];
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
      }
      const rest = this.length - i;
      if (rest === 1) {
        const n = this[i] << 16;
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
      } else if (rest === 2) {
        const n = (this[i] << 16) | (this[i + 1] << 8);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
      }
      return out;
    },
    writable: true,
    configurable: true,
  });
}

// Uint8Array.fromBase64 — same vintage; pdf.js uses it on the signature path.
if (typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 !== "function") {
  Object.defineProperty(Uint8Array, "fromBase64", {
    value: function fromBase64(str: string) {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
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
