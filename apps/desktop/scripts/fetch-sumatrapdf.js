// Downloads the portable SumatraPDF binary used by the print spooler
// (electron/print/spooler.js) into resources/print/SumatraPDF.exe.
//
// The binary is NOT committed — it is 16MB and GPLv3-licensed, so it is
// fetched at install/build time instead. The app still runs without it: the
// spooler falls back to Chromium printing, which is what shipped before.
//
// Run manually with: node scripts/fetch-sumatrapdf.js [--force]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = '3.5.2';
const URL = `https://www.sumatrapdfreader.org/dl/rel/${VERSION}/SumatraPDF-${VERSION}-64.zip`;
// sha256 of the zip above — pinned so a swapped upstream file is caught.
const ZIP_SHA256 = '66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989';
const EXE_IN_ZIP = `SumatraPDF-${VERSION}-64.exe`;

const destDir = path.join(__dirname, '..', 'resources', 'print');
const destExe = path.join(destDir, 'SumatraPDF.exe');
const force = process.argv.includes('--force');

function skip(reason) {
  console.log(`[fetch-sumatrapdf] skipped — ${reason}`);
  process.exit(0);
}

if (process.platform !== 'win32') skip('not Windows (the spooler is Windows-only)');
if (fs.existsSync(destExe) && !force) skip(`already present at ${destExe}`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumatra-'));
const zipPath = path.join(tmpDir, 'sumatra.zip');

try {
  console.log(`[fetch-sumatrapdf] downloading ${URL}`);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== ZIP_SHA256) {
    throw new Error(`checksum mismatch\n  expected ${ZIP_SHA256}\n  got      ${got}`);
  }
  fs.writeFileSync(zipPath, bytes);

  // Node has no zip reader in core; PowerShell ships with Windows.
  const unzip = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`],
    { stdio: 'inherit' },
  );
  if (unzip.status !== 0) throw new Error('Expand-Archive failed');

  const extracted = path.join(tmpDir, EXE_IN_ZIP);
  if (!fs.existsSync(extracted)) throw new Error(`${EXE_IN_ZIP} not found in the archive`);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(extracted, destExe);
  console.log(`[fetch-sumatrapdf] installed ${destExe}`);
} catch (err) {
  // Never fail the install/build over this — the Chromium fallback still prints.
  console.warn(`[fetch-sumatrapdf] WARNING: ${err.message}`);
  console.warn('[fetch-sumatrapdf] printing will fall back to the Chromium engine.');
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
