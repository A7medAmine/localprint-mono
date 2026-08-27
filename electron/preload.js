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

  // payload: { filePath, fileType, printerName, silent, options }
  //   - filePath   absolute path on disk (main will not accept URLs)
  //   - fileType   MIME string; pdf/image go through webContents.print,
  //                everything else falls through to shell.openPath
  //   - printerName Chromium deviceName; empty string uses OS default
  //   - silent     true = no dialog, false = show the OS print dialog
  //   - options    forwarded to webContents.print (duplexMode, color,
  //                copies, collate, landscape, …)
  // Resolves { ok: true, handedOff?: boolean } or rejects with an Error.
  printFile: (payload) => ipcRenderer.invoke('print-file', payload),

  // payload: { data, fileType, extension?, printerName, silent, options }
  //   - data       Uint8Array of the file bytes (Print Studio uses this
  //                for card layouts / reordered PDFs it builds in-memory)
  //   - extension  file extension to use for the tmp file (default ".pdf")
  //   Everything else matches printFile.
  printData: (payload) => ipcRenderer.invoke('print-data', payload),
});
