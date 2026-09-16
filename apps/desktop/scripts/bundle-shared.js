// electron-builder's asar packager refuses to follow a symlink whose real
// path escapes the app dir (apps/desktop) — and npm workspaces hoist
// @atba3li/shared into root node_modules as exactly that kind of symlink.
// Before packaging, replace apps/desktop's local copy with a real,
// dereferenced directory so everything the asar packer touches lives inside
// apps/desktop. Dev mode is untouched — this only runs as part of the
// electron:build / electron:release scripts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '..', '..', '..', 'packages', 'shared');
const dest = path.resolve(__dirname, '..', 'node_modules', '@atba3li', 'shared');

if (!fs.existsSync(src)) {
  throw new Error(`bundle-shared: source not found at ${src}`);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.cpSync(src, dest, { recursive: true, dereference: true });

console.log(`bundle-shared: copied ${src} -> ${dest}`);
