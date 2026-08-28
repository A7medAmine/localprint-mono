// Electron main process entry.
//
// On app-ready we start the existing Express server in-process (importing
// ../server.js is enough — it calls app.listen() at module top level), wait
// until /api/health responds, then open a BrowserWindow pointed at it.
//
// A fixed local port is used so multi-instance detection and any future
// deep-link/URL handling stay predictable. Port + host + NODE_ENV are set
// before the server.js import so server.js picks them up on load.

import { app, BrowserWindow, Menu, shell, ipcMain, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dotenv from 'dotenv';
import { checkEnv } from '../checkEnv.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Surface main-process crashes as a visible dialog + logfile instead of the
// process just vanishing. Without this the packaged app looks like "did not
// launch" when in fact it threw during startup.
function crashHandler(err) {
  const msg = (err && err.stack) || String(err);
  try {
    const logDir = app.isReady() ? app.getPath('userData') : path.join(process.env.APPDATA || __dirname, 'printshop-hub');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'main-error.log'), `[${new Date().toISOString()}]\n${msg}\n\n`);
  } catch { /* logging is best-effort */ }
  try { dialog.showErrorBox('PrintShop Hub — startup error', msg); } catch { /* pre-ready */ }
}
process.on('uncaughtException', crashHandler);
process.on('unhandledRejection', crashHandler);

// Dev mode = running against the Vite dev server + a separately-spawned
// node server.js (see the "electron:dev" npm script). In dev, Electron
// does NOT embed the server — it just opens a window at the Vite URL.
const IS_DEV = process.env.NODE_ENV === 'development';

// Uncommon high port to avoid clashes with common dev tools (3000/3001/5173/8080).
const SERVER_PORT = 47821;
// Bind Express to 0.0.0.0 so phones on the same Wi-Fi can hit the upload page
// via the shop's LAN IP (this is what /api/local-ip + the QR poster rely on).
// The Electron window itself always connects to the loopback address.
const SERVER_BIND_HOST = '0.0.0.0';
const LOOPBACK = '127.0.0.1';
const LOCAL_URL = `http://${LOOPBACK}:${SERVER_PORT}`;
// Time to wait after the load event before actually invoking webContents.print()
// on the hidden print window. did-finish-load fires when Chromium finishes the
// page shell, but the built-in PDFium plugin can still be painting the first
// page for a beat after that — printing during that window captures a
// not-yet-rendered frame and comes out blank/black. 250ms clears it reliably
// on the machines tested; pulled out as a constant so it's easy to bump if
// slower hardware needs more.
const PDF_RENDER_SETTLE_MS = 250;

// The Vite dev server the repo has always used (see vite.config.ts).
const DEV_URL = 'http://localhost:3000';


process.env.PORT = String(SERVER_PORT);
process.env.HOST = SERVER_BIND_HOST;

// Load .env from the packaged app resources. server.js's own `import 'dotenv/config'`
// resolves against process.cwd() (the install dir in a packaged build), which does
// not contain .env — so Gmail OAuth credentials come out undefined and login fails.
// Loading it here, before we import server.js, puts GOOGLE_CLIENT_ID / SECRET and
// GMAIL_REDIRECT_URI into process.env in time for the server to pick them up.
// In dev this is a no-op since server.js already loads .env from cwd.
if (app.isPackaged) {
  dotenv.config({ path: path.join(app.getAppPath(), '.env') });
  // The .env's GMAIL_REDIRECT_URI is set for the dev server (port 3000). The
  // packaged server binds SERVER_PORT — force the redirect URI to match, or
  // Google will send the browser to a port nothing is listening on. This URL
  // must also be registered in the Google Cloud Console OAuth client.
  // Must match exactly what's registered in the Google Cloud Console OAuth
  // client. Google treats "localhost" and "127.0.0.1" as different origins,
  // and the console entry uses "localhost".
  process.env.GMAIL_REDIRECT_URI = `http://localhost:${SERVER_PORT}/api/gmail/callback`;
} else {
  // In dev, load .env from the repo root BEFORE checkEnv() runs — otherwise
  // server.js's `import 'dotenv/config'` kicks in too late and the startup
  // validation below rejects TOKEN_ENCRYPTION_KEY as "not set".
  dotenv.config({ path: path.join(process.cwd(), '.env') });
}

// Chromium's auto-dark-mode inverts image + PDF content when the OS is in
// dark mode. That inversion is what made grayscale prints collapse to a solid
// black rectangle (inverted-then-grayscaled ≈ near-black). Only disable that
// one feature — earlier attempts also stripped CSSColorSchemeUARendering and
// forced the color profile, which had the opposite failure mode (the print
// preview came out blank white with no content).
// Must be set before app.whenReady().
app.commandLine.appendSwitch('disable-features', 'WebContentsForceDark');
// When packaged we always want production behavior (serve dist, no CORS shim).
if (app.isPackaged && !process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// In a packaged install the app dir is read-only under Program Files, so the
// SQLite file + uploads/ can't live next to the code. Redirect them to the
// per-user userData folder (e.g. %APPDATA%\PrintShop Hub\). server.js and db.js
// pick these up via env vars — set them BEFORE importing server.js.
//
// In dev (unpackaged) we leave the env vars unset so the existing repo-relative
// database.sqlite and uploads/ folder keep working exactly as before.
if (app.isPackaged) {
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'database.sqlite');
  const uploadsDir = path.join(userData, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  process.env.PRINTSHOP_DB_PATH = dbPath;
  process.env.PRINTSHOP_UPLOADS_DIR = uploadsDir;

  // db.js hard-requires TOKEN_ENCRYPTION_KEY (used to encrypt Gmail OAuth
  // tokens at rest). In dev this comes from .env; when packaged there's no
  // .env, so we generate a per-install key on first run and keep it in
  // userData. Rotating this file forces users to reconnect Gmail, so it's
  // written once and never touched again.
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    const keyPath = path.join(userData, 'token.key');
    let key;
    try {
      key = fs.readFileSync(keyPath, 'utf8').trim();
    } catch {
      key = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    process.env.TOKEN_ENCRYPTION_KEY = key;
  }
}

// Register a custom URL scheme so the Gmail-callback success page (opened in
// the OS browser) can pop the Electron app back to the front with a single
// click on "Return to PrintShop Hub". The protocol payload is discarded — we
// use it as a focus signal, not a router.
const PROTOCOL = 'printshop-hub';
if (process.defaultApp && process.argv.length >= 2) {
  // In dev, `electron .` needs the script path passed through for the
  // registered handler to relaunch correctly.
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Second launch focuses the existing window instead of starting a second server
// on an already-bound port. Also handles the case where Windows re-launches
// the app because the OS browser opened a printshop-hub:// URL.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// Poll /api/health until it responds 200 or we time out.
async function waitForServer(url, timeoutMs = 15_000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(1_000, () => req.destroy(new Error('timeout')));
      });
      return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms (last: ${lastErr?.message})`);
}

// Trimmed menu — Reload is included (staff-useful for network hiccups / stale
// state), DevTools + Force-Reload are not (dev-only clutter).
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f8fafc',
    // Show the window right away. We used to wait for `ready-to-show`, but if
    // renderer setup ever hangs (offscreen coords from a prior session, gpu
    // fallback slow to init, load stuck on a redirect) the event never fires
    // and the user sees "nothing launched" while the process is actually
    // running headless. Showing immediately means the empty window paints
    // first (backgroundColor above) and content fills in when it's ready —
    // no worse than any browser tab.
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Preload exposes the print IPC bridge (window.electronPrint).
      // Kept sandbox-compatible — see electron/preload.js.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // window.open handling. OAuth to Google is routed to the OS browser so it
  // picks up the user's existing Google session (Electron has its own cookie
  // jar and can't share cookies with Chrome/Edge — this is Google's
  // recommended desktop OAuth flow anyway: external browser + loopback
  // callback). Everything else also goes to the OS browser so we don't turn
  // this app into a general-purpose browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // F5 as a second reload accelerator (Ctrl+R is on the menu). Shop staff
  // hit F5 by muscle memory. F12 as a second DevTools accelerator so
  // debugging works without opening the menu.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' && !input.control && !input.meta && !input.alt) {
      mainWindow.webContents.reload();
      event.preventDefault();
    } else if (input.key === 'F12' && !input.control && !input.meta && !input.alt) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Belt-and-suspenders — even with `show: true` above, force a focus once
  // the first paint is ready so the window comes to the front on Windows
  // (some installs open it behind other apps otherwise).
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  // If the page fails to load, don't leave the user staring at a blank window.
  // Render an inline error page they can screenshot and open DevTools from.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, validatedURL) => {
    if (code === -3) return; // aborted (usually because we navigated away)
    const html = `<!doctype html><meta charset="utf-8"><title>PrintShop Hub — load failed</title>
      <body style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;padding:32px;color:#111;background:#f8fafc">
        <h1 style="margin:0 0 8px">Couldn't load the app</h1>
        <p style="color:#555">The embedded server is running but the window failed to load its page.</p>
        <pre style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;white-space:pre-wrap">${code} — ${description}
${validatedURL}</pre>
        <p>Press <b>F12</b> to open DevTools, or <b>Ctrl+R</b> to retry.</p>
      </body>`;
    mainWindow?.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Shop staff run this on the counter machine — land them on the admin panel.
  // /admin resolves to the dashboard if a saved session exists, otherwise the
  // login page. The upload page stays reachable over the LAN via the QR code.
  const baseUrl = IS_DEV ? DEV_URL : LOCAL_URL;
  mainWindow.loadURL(`${baseUrl}/admin`).catch((err) => {
    console.error('loadURL failed:', err);
  });
}

// MIME types Chromium can render (and therefore print) directly. Everything
// else goes through shell.openPath — Word/Excel/etc. render fine only in
// their native apps, and Chromium's built-in PDF viewer covers PDFs.
function isChromiumPrintable(fileType) {
  if (!fileType) return false;
  if (fileType === 'application/pdf') return true;
  if (fileType.startsWith('image/')) return true;
  return false;
}

// Native print for a pdf/image on disk. A hidden BrowserWindow renders the
// file, prints it, and is destroyed regardless of outcome so we don't leak
// windows on driver errors.
async function assertPrinterExists(printerName) {
  if (!printerName) return; // empty === OS default, always valid
  let list = [];
  try {
    const source = mainWindow?.webContents;
    if (source) {
      list = await source.getPrintersAsync();
    } else {
      const tmp = new BrowserWindow({ show: false });
      try { list = await tmp.webContents.getPrintersAsync(); }
      finally { tmp.destroy(); }
    }
  } catch { return; /* can't enumerate — let the print attempt surface it */ }
  if (!list.some((p) => p.name === printerName)) {
    throw new Error(
      `Printer "${printerName}" was not found. It may be offline or removed — ` +
      `pick a printer again in Settings.`,
    );
  }
}

function nativePrint({ filePath, printerName, silent, options }) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      // Must be a *shown* window, just parked off-screen. `show: false` skips
      // compositing on Windows/Electron 33 — webContents.print() then snapshots
      // an uninitialized frame buffer and the printer receives a solid black
      // page. Shown-but-off-screen forces a real paint frame without ever
      // being visible to the user.
      show: true,
      x: -10000,
      y: -10000,
      // A concrete letter-ish size — a zero/default sized off-screen window
      // can still fail to composite on some drivers.
      width: 850,
      height: 1100,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      // Force white — Chromium's built-in PDF viewer and default image
      // container inherit the OS color scheme, so on a dark-mode Windows
      // machine the render surface starts dark. That's what made grayscale
      // prints come out solid black: dark bg + color→gray conversion
      // collapses to near-black across the whole page.
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The built-in PDF viewer is what makes webContents.print() work
        // against a PDF loaded via loadFile — it's on by default in
        // Electron 33 but stating it here is documentation for the next
        // reader.
        plugins: true,
      },
    });

    // Same reason as backgroundColor above — pin this hidden window to the
    // light theme regardless of the OS setting. Scoped to the window's
    // WebContents via `themeSource` on the session isn't a thing; the app-
    // global `nativeTheme.themeSource` briefly flipped to 'light' while the
    // print window is up is the accepted workaround.
    const priorTheme = nativeTheme.themeSource;
    nativeTheme.themeSource = 'light';

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { win.destroy(); } catch { /* already gone */ }
      nativeTheme.themeSource = priorTheme;
      if (err) reject(err);
      else resolve(value);
    };

    // did-finish-load is Chromium telling us the document is laid out.
    // For PDFs the built-in viewer emits it once the first page is ready.
    win.webContents.once('did-finish-load', async () => {
      // Pin color-scheme to light so no UA dark styling leaks in.
      try {
        await win.webContents.insertCSS(':root { color-scheme: light; }');
      } catch { /* not fatal */ }

      // Grayscale strategy: DON'T rely on Chromium's `color: false`. On
      // Windows / Electron 33 that path repeatedly renders images and PDF
      // pages as a solid dark rectangle regardless of what we do to
      // WebContentsForceDark, background color, or theme source. Instead we
      // apply a CSS `filter: grayscale(1)` to the render surface (Chromium
      // composites CSS filters over PDFium/image content as a post-composite
      // step, so the printer receives already-desaturated pixels) and tell
      // Chromium to print in color mode. Cleaner conversion, same result,
      // works with any driver.
      const wantGrayscale = options && options.color === false;
      if (wantGrayscale) {
        try {
          await win.webContents.insertCSS(
            'html, body, embed, iframe, img, object, canvas { filter: grayscale(100%) !important; -webkit-filter: grayscale(100%) !important; }',
          );
        } catch { /* not fatal */ }
      }

      // Unconditional settle before print. did-finish-load fires when the
      // page shell is done, but the PDFium plugin can still be painting the
      // first page — printing during that beat captures a not-yet-rendered
      // frame. Also covers the CSS-filter compositor race for grayscale.
      await new Promise((r) => setTimeout(r, PDF_RENDER_SETTLE_MS));

      // Drop caller's `color` — see note above: always print color:true and
      // let the grayscale CSS filter above (if any) do the desaturation.
      const restOptions = { ...(options || {}) };
      delete restOptions.color;
      const printOptions = {
        silent: silent === true,
        // Empty deviceName tells Chromium to use the OS default printer.
        deviceName: printerName || '',
        // Print full-bleed for images/PDFs — page backgrounds matter.
        printBackground: true,
        ...restOptions,
        // Always tell Chromium to print in color; grayscale (if requested) has
        // already been baked into the pixels via CSS filter above.
        color: true,
      };
      try {
        win.webContents.print(printOptions, (success, failureReason) => {
          if (success) return finish(null, { ok: true });
          // User-cancelled dialog isn't an error the UI should shout about,
          // but it also isn't a successful print — surface it distinctly.
          // Chromium reports cancellation with a few different strings across
          // versions/platforms ("cancelled", "canceled", "Print job canceled"),
          // and sometimes with an empty reason when silent=false and the user
          // dismisses the OS dialog. Treat all of those as cancellation.
          const reason = String(failureReason || '').toLowerCase();
          if (!reason || reason.includes('cancel')) {
            return finish(null, { ok: false, cancelled: true });
          }
          finish(new Error(failureReason || 'Print failed'));
        });
      } catch (err) {
        finish(err);
      }
    });

    win.webContents.once('did-fail-load', (_e, _code, description) => {
      finish(new Error(`Failed to load file for printing: ${description}`));
    });

    win.loadFile(filePath).catch((err) => finish(err));
  });
}

// IPC surface — see electron/preload.js for the renderer-facing shape.
ipcMain.handle('get-printers', async () => {
  // getPrintersAsync lives on webContents, not app. Any live webContents
  // works — prefer the main window if it exists, otherwise spin up a
  // throwaway one just for the lookup.
  const source = mainWindow?.webContents || null;
  if (source) return source.getPrintersAsync();
  const tmp = new BrowserWindow({ show: false });
  try {
    return await tmp.webContents.getPrintersAsync();
  } finally {
    tmp.destroy();
  }
});

// Print Studio generates PDFs in-memory (card layouts, page reorders) that
// never touch the jobs store. Rather than saving them just to print, the
// renderer sends the raw bytes here — we drop them in the OS tmp dir, print,
// then unlink. Same IPC surface as print-file so both share nativePrint.
ipcMain.handle('print-data', async (_event, payload) => {
  const { data, fileType, printerName, silent, options, extension } = payload || {};
  if (!data || !(data instanceof Uint8Array || Buffer.isBuffer(data) || data instanceof ArrayBuffer)) {
    throw new Error('print-data: data (Uint8Array/Buffer) is required');
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const ext = extension && /^\.[a-z0-9]+$/i.test(extension) ? extension : '.pdf';
  const tmpPath = path.join(os.tmpdir(), `printshop-${crypto.randomBytes(8).toString('hex')}${ext}`);
  fs.writeFileSync(tmpPath, buf);
  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };
  try {
    if (!isChromiumPrintable(fileType || 'application/pdf')) {
      const errMsg = await shell.openPath(tmpPath);
      if (errMsg) throw new Error(errMsg);
      // Don't unlink immediately — the external app still has the file open.
      // Best-effort cleanup after a minute.
      setTimeout(cleanup, 60_000);
      return { ok: true, handedOff: true };
    }
    await assertPrinterExists(printerName);
    const result = await nativePrint({ filePath: tmpPath, printerName, silent, options });
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
});

ipcMain.handle('print-file', async (_event, payload) => {
  const { filePath, fileType, printerName, silent, options } = payload || {};
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('print-file: filePath is required');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`print-file: file not found (${filePath})`);
  }

  // Word/Excel/etc. — hand off to the OS's registered app. Same pattern
  // Telegram/Slack use for "open with default app".
  if (!isChromiumPrintable(fileType)) {
    const errMsg = await shell.openPath(filePath);
    // shell.openPath resolves to '' on success and to an error string on
    // failure (e.g. no default app registered for that extension).
    if (errMsg) throw new Error(errMsg);
    return { ok: true, handedOff: true };
  }

  await assertPrinterExists(printerName);
  return nativePrint({ filePath, printerName, silent, options });
});

app.whenReady().then(async () => {
  buildMenu();

  // Surface bad/missing env as a dialog instead of a white-screen window.
  // (Packaged builds have already injected TOKEN_ENCRYPTION_KEY above.)
  const envProblems = checkEnv({ exit: false });
  if (envProblems.length) {
    crashHandler(new Error(
      'Cannot start — environment problems:\n\n' +
      envProblems.map((p, i) => `${i + 1}. ${p}`).join('\n\n'),
    ));
    app.quit();
    return;
  }

  try {
    // Always embed the Express server in the Electron process. This keeps a
    // single better-sqlite3 build (against Electron's Node ABI) — running a
    // separate `node server.js` would need a second build against the system
    // Node ABI and the two would fight over @electron/rebuild.
    await import('../server.js');
    await waitForServer(`${LOCAL_URL}/api/health`);
    if (IS_DEV) {
      // In dev the frontend comes from Vite (HMR). Vite proxies /api to the
      // embedded server via VITE_API_TARGET (set by the electron:dev script).
      await waitForServer(DEV_URL, 30_000);
    }
  } catch (err) {
    console.error('❌ Failed waiting for server:', err.message);
    crashHandler(err);
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// Close the DB cleanly before the process exits. Importing db.js returns the
// same singleton connection server.js already opened, so this doesn't create
// a second handle.
app.on('will-quit', async () => {
  try {
    const { checkpointAndClose } = await import('../db.js');
    checkpointAndClose();
  } catch { /* nothing to close */ }
});
