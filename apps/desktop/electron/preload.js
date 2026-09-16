// Sandbox-safe preload. The renderer never sees ipcRenderer directly —
// contextBridge exposes only the two typed print calls it actually needs.
// Kept minimal on purpose: if we ever need more IPC surface, add named
// methods here rather than exposing a generic `invoke`.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronPrint', {
  // Resolves to Electron's PrinterInfo[] (name, displayName, description,
  // status, isDefault, options). The renderer uses `name` when calling
  // printFile — that's what maps to Chromium's deviceName.
  getPrinters: () => ipcRenderer.invoke('get-printers'),

  // Resolves { engine: 'spooler' | 'chromium', exePath, platform } — which
  // print engine this install will use (see electron/print/spooler.js).
  getPrintEngine: () => ipcRenderer.invoke('get-print-engine'),

  // payload: { filePath, fileType, printerName, silent, options }
  //   - filePath   absolute path on disk (main will not accept URLs)
  //   - fileType   MIME string; pdf/image are printed natively, everything
  //                else falls through to shell.openPath
  //   - printerName printer name; empty string uses the OS default
  //   - silent     false forces the Chromium engine + OS print dialog; any
  //                other value uses the spooler engine, which never shows UI
  //   - options    duplexMode, color, copies, collate, landscape, pageSize,
  //                pageRanges
  // Resolves { ok: true, handedOff?: boolean } or rejects with an Error.
  printFile: (payload) => ipcRenderer.invoke('print-file', payload),

  // payload: { data, fileType, extension?, printerName, silent, options }
  //   - data       Uint8Array of the file bytes (Print Studio uses this
  //                for card layouts / reordered PDFs it builds in-memory)
  //   - extension  file extension to use for the tmp file (default ".pdf")
  //   Everything else matches printFile.
  printData: (payload) => ipcRenderer.invoke('print-data', payload),
});
