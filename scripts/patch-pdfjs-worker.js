// Patch pdfjs-dist's worker files with a Uint8Array.prototype.toHex polyfill.
//
// pdf.js v5's worker calls `.toHex()` on Uint8Array (see pdf.worker.mjs
// where it hashes trailer IDs). That method requires Chromium 131+ / Node
// 22.7+ — Electron 33 ships Chromium 130 and blows up with "a.toHex is
// not a function".
//
// The obvious "wrap the worker source in a Blob URL and prepend a polyfill"
// approach breaks because the worker uses `import.meta.url` internally to
// fetch its openjpeg.wasm sibling — from a blob: URL that resolution has
// no base and WASM loading fails.
//
// Patching the file on disk keeps `import.meta.url` pointing at the real
// served location. Runs from postinstall; safe to run repeatedly (skips
// files that already carry the polyfill marker).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Bump the marker whenever the polyfill body changes so postinstall
// re-patches files that already carry an older version of it.
const MARKER = '/*!ps-pdfjs-polyfills-v2*/';
const POLYFILL =
  MARKER +
  // Uint8Array.prototype.toHex — TC39 stage-3, Chromium 131+ / Node 22.7+.
  // Electron 33 ships Chromium 130. pdf.js v5's worker hashes trailer IDs
  // with it; without the polyfill the worker throws "a.toHex is not a function".
  "if(typeof Uint8Array.prototype.toHex!=='function'){" +
  "Object.defineProperty(Uint8Array.prototype,'toHex',{value:function(){" +
  "let s='';for(let i=0;i<this.length;i++)s+=this[i].toString(16).padStart(2,'0');" +
  "return s;},writable:true,configurable:true});}" +
  // Map.prototype.getOrInsert / getOrInsertComputed — TC39 stage-3, Chromium
  // 133+. pdf.js v5's rendering path uses getOrInsertComputed for its cache
  // maps and throws "getOrInsertComputed is not a function" on Electron 33.
  "if(typeof Map.prototype.getOrInsert!=='function'){" +
  "Object.defineProperty(Map.prototype,'getOrInsert',{value:function(k,v){" +
  "if(this.has(k))return this.get(k);this.set(k,v);return v;" +
  "},writable:true,configurable:true});}" +
  "if(typeof Map.prototype.getOrInsertComputed!=='function'){" +
  "Object.defineProperty(Map.prototype,'getOrInsertComputed',{value:function(k,f){" +
  "if(this.has(k))return this.get(k);const v=f(k);this.set(k,v);return v;" +
  "},writable:true,configurable:true});}" +
  // WeakMap has the same pair of proposal methods on the same track.
  "if(typeof WeakMap.prototype.getOrInsert!=='function'){" +
  "Object.defineProperty(WeakMap.prototype,'getOrInsert',{value:function(k,v){" +
  "if(this.has(k))return this.get(k);this.set(k,v);return v;" +
  "},writable:true,configurable:true});}" +
  "if(typeof WeakMap.prototype.getOrInsertComputed!=='function'){" +
  "Object.defineProperty(WeakMap.prototype,'getOrInsertComputed',{value:function(k,f){" +
  "if(this.has(k))return this.get(k);const v=f(k);this.set(k,v);return v;" +
  "},writable:true,configurable:true});}\n";

const TARGETS = [
  'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  'node_modules/pdfjs-dist/build/pdf.worker.mjs',
];

let patchedCount = 0;
let skippedCount = 0;
let missingCount = 0;

for (const rel of TARGETS) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    missingCount++;
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');
  if (src.startsWith(MARKER)) {
    skippedCount++;
    continue;
  }
  fs.writeFileSync(full, POLYFILL + src);
  patchedCount++;
  console.log(`  patched ${rel}`);
}

if (patchedCount === 0 && skippedCount > 0) {
  console.log(`pdfjs worker already patched (${skippedCount} file${skippedCount === 1 ? '' : 's'}).`);
} else if (patchedCount > 0) {
  console.log(`pdfjs worker: patched ${patchedCount}, already patched ${skippedCount}.`);
}
if (missingCount === TARGETS.length) {
  console.warn('⚠️  pdfjs-dist not installed yet — patch will run again on next install.');
}
