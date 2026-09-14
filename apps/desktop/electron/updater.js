// Auto-update via electron-updater against GitHub Releases.
//
// electron-builder's `publish` config (package.json → build.publish) points
// this at the GH_TOKEN-authenticated repo; the GitHub Actions release
// workflow (.github/workflows/release.yml) is what actually pushes the
// installer + latest.yml to a Release when a `v*` tag is pushed.
//
// Only runs when packaged — electron-updater errors out on an unpackaged
// dev build (no app-update.yml), so this is a no-op under `electron:dev`.

import { app, dialog, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

let started = false;
// Set for the duration of a manually-triggered check so the result
// handlers (not-available / error) know to surface a dialog — the
// background 4h poll stays silent on "nothing to do" outcomes.
let manualCheckInFlight = false;

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

export function initAutoUpdater() {
  if (started || !app.isPackaged) return;
  started = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message || err);
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      dialog.showMessageBox(focusedWindow(), {
        type: 'error',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: err?.message || String(err),
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      dialog.showMessageBox(focusedWindow(), {
        type: 'info',
        title: 'No updates',
        message: 'You are running the latest version.',
      });
    }
  });

  autoUpdater.on('update-available', (info) => {
    // Download starts automatically (autoDownload: true) — this just tells
    // a manual checker that something is on the way instead of leaving them
    // wondering why "Check for Updates" seemed to do nothing.
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      dialog.showMessageBox(focusedWindow(), {
        type: 'info',
        title: 'Update found',
        message: `Downloading PrintShop Hub ${info.version}…`,
        detail: 'You will be prompted to restart once the download finishes.',
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    const win = focusedWindow();
    if (win) win.setProgressBar(progress.percent / 100);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const win = focusedWindow();
    if (win) win.setProgressBar(-1); // clear taskbar progress
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: `PrintShop Hub ${info.version} downloaded.`,
      detail: 'Restart to install the update. It will also install automatically the next time the app quits.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Check on launch, then every 4 hours — long enough not to be noisy on a
  // machine left running all day, short enough to pick up same-day fixes.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error('[updater] initial check failed:', err?.message || err);
  });
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] periodic check failed:', err?.message || err);
    });
  }, 4 * 60 * 60 * 1000);
}

// Wired to Help → "Check for Updates…". Unlike the background poll, this
// always tells the user something happened (found / not found / failed) —
// see manualCheckInFlight above.
export function checkForUpdatesManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox(focusedWindow(), {
      type: 'info',
      title: 'Check for Updates',
      message: 'Auto-update is only available in the installed app, not in dev mode.',
    });
    return;
  }
  manualCheckInFlight = true;
  autoUpdater.checkForUpdates().catch((err) => {
    manualCheckInFlight = false;
    console.error('[updater] manual check failed:', err?.message || err);
    dialog.showMessageBox(focusedWindow(), {
      type: 'error',
      title: 'Update check failed',
      message: 'Could not check for updates.',
      detail: err?.message || String(err),
    });
  });
}
