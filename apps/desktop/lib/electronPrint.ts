// Thin renderer-side wrapper around window.electronPrint (see
// electron/preload.js). Kept as a module so components can `import` it
// without repeating the `window as any` cast, and so the browser build
// (no Electron) still type-checks and degrades gracefully.
import type { PrinterJobDefaults } from "../types";

export interface PrinterInfo {
  name: string;
  displayName: string;
  description?: string;
  status: number;
  isDefault: boolean;
  options?: Record<string, string>;
}

export interface PrintFilePayload {
  filePath: string;
  fileType: string;
  printerName?: string;
  silent?: boolean;
  options?: Partial<PrinterJobDefaults> & Record<string, unknown>;
}

export interface PrintDataPayload {
  data: Uint8Array;
  fileType: string;
  extension?: string;
  printerName?: string;
  silent?: boolean;
  options?: Partial<PrinterJobDefaults> & Record<string, unknown>;
}

export interface PrintFileResult {
  ok: boolean;
  cancelled?: boolean;
  handedOff?: boolean;
}

export interface RenderHtmlPdfPayload {
  /** A self-contained document — fonts and images must already be inlined. */
  html: string;
  pageSize?: string;
  landscape?: boolean;
}

export interface PrintEngineInfo {
  /** "spooler" = SumatraPDF via the Windows spooler, "chromium" = fallback. */
  engine: "spooler" | "chromium";
  exePath: string | null;
  platform: string;
}

interface ElectronPrintBridge {
  getPrinters(): Promise<PrinterInfo[]>;
  getPrintEngine(): Promise<PrintEngineInfo>;
  printFile(payload: PrintFilePayload): Promise<PrintFileResult>;
  printData(payload: PrintDataPayload): Promise<PrintFileResult>;
  renderHtmlPdf(payload: RenderHtmlPdfPayload): Promise<Uint8Array>;
}

function bridge(): ElectronPrintBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { electronPrint?: ElectronPrintBridge }).electronPrint ?? null;
}

export function isElectron(): boolean {
  return bridge() !== null;
}

export async function getPrinters(): Promise<PrinterInfo[]> {
  const b = bridge();
  if (!b) return [];
  return b.getPrinters();
}

/** Which engine will spool jobs, or null outside the desktop app. */
export async function getPrintEngine(): Promise<PrintEngineInfo | null> {
  const b = bridge();
  if (!b?.getPrintEngine) return null;
  return b.getPrintEngine();
}

// True while a native print job is in flight. The main process pins the
// app-global nativeTheme.themeSource to 'light' for the hidden print window
// (see electron/main.js nativePrint), which briefly fires
// prefers-color-scheme changes in every window. Renderers (App.tsx) skip
// reacting to those so a print doesn't flash the app's theme.
let nativePrintActive = false;

export function isNativePrintActive(): boolean {
  return nativePrintActive;
}

function withNativePrint<T>(fn: () => Promise<T>): Promise<T> {
  nativePrintActive = true;
  return fn().finally(() => {
    nativePrintActive = false;
  });
}

export async function printFile(payload: PrintFilePayload): Promise<PrintFileResult> {
  const b = bridge();
  if (!b) throw new Error("Native printing is only available in the desktop app.");
  return withNativePrint(() => b.printFile(payload));
}

export async function printData(payload: PrintDataPayload): Promise<PrintFileResult> {
  const b = bridge();
  if (!b) throw new Error("Native printing is only available in the desktop app.");
  return withNativePrint(() => b.printData(payload));
}

/**
 * An HTML page rendered to PDF bytes by the main process, so it can be spooled
 * through the same engine as every other job instead of Chromium's own print
 * dialog. The HTML must be self-contained — it is rendered from a tmp file, so
 * app-relative URLs (fonts, logos) do not resolve.
 */
export async function renderHtmlPdf(payload: RenderHtmlPdfPayload): Promise<Uint8Array> {
  const b = bridge();
  if (!b?.renderHtmlPdf) throw new Error("PDF rendering is only available in the desktop app.");
  return b.renderHtmlPdf(payload);
}
