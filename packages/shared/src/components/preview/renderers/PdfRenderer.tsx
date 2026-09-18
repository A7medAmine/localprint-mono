import React, { useState, useEffect } from "react";
import { Icon } from "../../ui/icon";
import { errorMessage } from "@atba3li/shared";
import PdfCanvasRenderer from "./PdfCanvasRenderer";

// Mobile browsers (iOS Safari, Android Chrome) ship no PDF plugin: they swap
// an <embed>/<iframe> pointed at a PDF for a download button, so the preview
// below never appears. `navigator.pdfViewerEnabled` is the spec'd way to ask
// — true on desktop Chromium/Firefox/Safari and in Electron with
// `plugins: true`, false on mobile. Older engines without the property fall
// back to the native viewer, which is where they worked before.
function hasNativePdfViewer(): boolean {
  if (typeof navigator === "undefined") return true;
  const flag = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  return flag === undefined ? true : flag;
}

interface PdfRendererProps {
  src: string;
  /** 0-indexed inclusive ranges (as parsed from a "1-3, 5" field). Empty/undefined = all pages. */
  pageRanges?: { from: number; to: number }[];
  isRtl?: boolean;
}

const PdfLoadingSkeleton: React.FC = () => (
  <div className="flex items-center justify-center h-full min-h-[300px]">
    <div className="flex flex-col items-center gap-4 animate-pulse">
      <div className="w-14 h-14 rounded-xl bg-muted" />
      <div className="h-3 w-32 rounded-full bg-muted" />
      <div className="h-2.5 w-48 rounded-full bg-gray-100 dark:bg-gray-600" />
    </div>
  </div>
);

// Renders through the host's built-in PDF viewer (PDFium in Electron/Chromium,
// the browser's own viewer on the web) rather than rasterising with pdf.js.
// pdf.js's glyph rasterizer mis-renders some embedded Arabic fonts — letters
// come out scrambled — while the exact same file prints correctly, because
// printing already goes through this native engine (see chromiumPrint() in
// apps/desktop/electron/main.js).
//
// The bytes are fetched and handed over as a blob: URL instead of pointing
// <embed> straight at `src`. A blob carries no response headers, so the
// app-wide X-Frame-Options: DENY (which Chromium applies to plugin frames
// exactly as it does to iframes) can't block it. It also keeps this working
// for endpoints that only answer to an authenticated fetch.
//
// Needs `webPreferences.plugins: true` on the Electron window, and blob: in
// the CSP's object-src/frame-src — without the CSP entry the viewer frame is
// dropped silently, with nothing logged.
//
// Hosts with no PDF plugin (every mobile browser) get PdfCanvasRenderer
// instead — see hasNativePdfViewer() above.
const PdfRenderer: React.FC<PdfRendererProps> = ({ src, pageRanges, isRtl }) => {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Decided once per mount: the host either has a PDF plugin or it doesn't.
  const [native] = useState(hasNativePdfViewer);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    setBlobUrl(null);
    setBytes(null);
    setError(null);

    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // Without a plugin the bytes go to pdf.js, which wants a buffer, not
        // an object URL.
        return (native ? r.blob() : r.arrayBuffer()) as Promise<Blob | ArrayBuffer>;
      })
      .then((payload: Blob | ArrayBuffer) => {
        if (cancelled) return;
        if (payload instanceof ArrayBuffer) {
          setBytes(payload);
          return;
        }
        created = URL.createObjectURL(new Blob([payload], { type: "application/pdf" }));
        setBlobUrl(created);
      })
      .catch((err) => {
        // Kept unlocalised in state so a language toggle doesn't re-fetch the file.
        if (!cancelled) setError(errorMessage(err) || "");
      });

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, native]);

  if (error !== null) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-muted-foreground gap-3">
        <Icon name="alert-circle" className="w-12 h-12" />
        <p className="text-sm font-medium">{error || (isRtl ? "تعذّر تحميل ملف PDF" : "Failed to load PDF")}</p>
      </div>
    );
  }

  if (!native) {
    if (!bytes) return <PdfLoadingSkeleton />;
    return <PdfCanvasRenderer data={bytes} pageRanges={pageRanges} isRtl={isRtl} />;
  }

  if (!blobUrl) return <PdfLoadingSkeleton />;

  // The native viewer exposes no API to restrict paging, so a page range only
  // decides which page it opens on.
  const startPage = pageRanges && pageRanges.length > 0 ? pageRanges[0].from + 1 : undefined;

  // PDFium's own open-parameters (toolbar/navpanes/statusbar/scrollbar=0)
  // strip its built-in toolbar — filename, page count, zoom, download/print
  // icons — since this preview sits inside our own dialog chrome already.
  const fragmentParams = ["toolbar=0", "navpanes=0", "statusbar=0"];
  if (startPage !== undefined) fragmentParams.unshift(`page=${startPage}`);
  const embedSrc = `${blobUrl}#${fragmentParams.join("&")}`;

  return (
    <div className="flex flex-col h-full" dir={isRtl ? "rtl" : "ltr"}>
      {startPage !== undefined && (
        <div className="px-4 py-2 border-b border-border shrink-0 text-xs text-indigo-600 dark:text-indigo-400 font-medium">
          {isRtl
            ? `المعاينة تبدأ من الصفحة ${startPage} — سيُطبع النطاق المحدد كاملاً`
            : `Preview starts at page ${startPage} — the full selected range will print`}
        </div>
      )}
      {/* Keyed on the page anchor: swapping only the `src` attribute on an
          already-mounted <embed> doesn't reliably re-navigate the native
          PDFium plugin (Electron/Chromium) — it just goes blank. A key
          forces React to tear down and remount the plugin instance instead. */}
      <embed
        key={startPage ?? "all"}
        src={embedSrc}
        type="application/pdf"
        className="w-full h-full flex-1"
      />
    </div>
  );
};

export default PdfRenderer;
