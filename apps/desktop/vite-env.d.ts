/// <reference types="vite/client" />

// Uint8Array.prototype.toHex is a TC39 stage-3 addition landed in Chromium
// 131 / Node 22.7. We polyfill it in PDFJobManager for older engines
// (Electron 33 ships Chromium 130); this declaration keeps TS happy.
interface Uint8Array {
  toHex(): string;
}
