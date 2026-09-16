// Windows print engine: hand a PDF to the OS spooler through SumatraPDF.
//
// Replaces webContents.print() as the default path. Chromium's print path on
// Windows silently drops duplex / collate / copies for most drivers, renders
// off-screen windows as blank or black pages on some GPU/driver combinations,
// and sometimes never fires its completion callback at all (which is why the
// old code needed a watchdog and reported "sent" for jobs that never spooled).
//
// SumatraPDF is a separate process talking to the Windows spooler: the settings
// land in a DEVMODE the driver honours, there is no compositor involved, and
// the process exit code is a real success/failure signal.
//
// The binary is not committed to the repo — scripts/fetch-sumatrapdf.js pulls
// it into resources/print/ at install/build time. When it is missing,
// isSpoolerAvailable() returns false and the caller falls back to Chromium.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPrintSettings } from './settings.js';
import { preparePrintPdf } from './prepare.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Generous, but bounded: a large PDF on a slow USB laser can take a while to
// render and spool. Past this the child is killed and the job reported failed
// rather than hanging the UI forever.
const SPOOL_TIMEOUT_MS = 120_000;

let cachedExe;

/** Absolute path to the bundled SumatraPDF, or null when it is not installed. */
export function spoolerExePath() {
  if (cachedExe !== undefined) return cachedExe;
  const candidates = [
    // Packaged: electron-builder copies resources/print -> resources/print.
    path.join(process.resourcesPath || '', 'print', 'SumatraPDF.exe'),
    // Dev: apps/desktop/resources/print/SumatraPDF.exe
    path.join(__dirname, '..', '..', 'resources', 'print', 'SumatraPDF.exe'),
  ];
  cachedExe = candidates.find((p) => p && fs.existsSync(p)) || null;
  return cachedExe;
}

/** True when this platform + install can use the spooler engine. */
export function isSpoolerAvailable() {
  return process.platform === 'win32' && spoolerExePath() !== null;
}

function runSumatra(args) {
  return new Promise((resolve, reject) => {
    const exe = spoolerExePath();
    if (!exe) return reject(new Error('SumatraPDF is not installed'));

    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // SumatraPDF reports the actual reason on stdout ("Printing problem.: …"),
    // not stderr, so both streams are collected.
    let out = '';
    let timer = null;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };

    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) return finish(null, { ok: true });
      const problem = /Printing problem\.:\s*(.+)/.exec(out);
      finish(new Error(
        problem
          ? `Printing failed: ${problem[1].trim()}`
          : `Printing failed (print engine exit code ${code}).`,
      ));
    });

    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new Error('Printing timed out — the printer did not accept the job.'));
    }, SPOOL_TIMEOUT_MS);
  });
}

/**
 * Print a PDF or image through the Windows spooler.
 *
 * { filePath, fileType, printerName, options } — the same shape the print-file
 * IPC handler receives. An empty printerName means the OS default printer.
 * Resolves { ok: true }; rejects with a human-readable Error on failure.
 */
export async function spoolerPrint({ filePath, fileType, printerName, options = {} }) {
  const { pdfPath, options: prepared, cleanup } = await preparePrintPdf({ filePath, fileType, options });
  try {
    const settings = buildPrintSettings(prepared);
    const args = printerName
      ? ['-print-to', printerName]
      : ['-print-to-default'];
    args.push('-print-settings', settings, '-silent', '-exit-when-done', pdfPath);
    return await runSumatra(args);
  } finally {
    cleanup();
  }
}
