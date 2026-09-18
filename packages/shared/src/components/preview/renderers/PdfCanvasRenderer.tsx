import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../../ui/icon";
import { getPdfjs, PDF_DOC_OPTIONS } from "../../../lib/pdfRender";
import { errorMessage } from "@atba3li/shared";

interface PdfCanvasRendererProps {
  /** Already-fetched PDF bytes — the parent owns the network call. */
  data: ArrayBuffer;
  /** 0-indexed inclusive ranges. The first one decides which page we scroll to. */
  pageRanges?: { from: number; to: number }[];
  isRtl?: boolean;
}

/** Cap the backing store so a 300-page file can't exhaust mobile GPU memory. */
const MAX_DPR = 2;

// Rasterises with pdf.js instead of handing the file to a native viewer.
//
// Mobile browsers ship no PDF plugin: an <embed>/<iframe> pointed at a PDF is
// replaced by a download ("Open") button, so the preview never appears. This
// renderer is the fallback for those hosts. It goes through the shared
// `PDF_DOC_OPTIONS` (disableFontFace), which is what keeps Arabic
// Identity-H/CID text from coming out as disconnected glyphs.
//
// Pages are laid out at their real aspect ratio up front and rasterised only
// as they scroll into view, so opening a long document stays cheap.
const PdfCanvasRenderer: React.FC<PdfCanvasRendererProps> = ({ data, pageRanges, isRtl }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<any>(null);
  const [pages, setPages] = useState<{ width: number; height: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startPage = pageRanges && pageRanges.length > 0 ? pageRanges[0].from + 1 : undefined;

  useEffect(() => {
    let cancelled = false;
    let doc: any = null;

    setPages([]);
    setError(null);

    (async () => {
      try {
        const pdfjs = await getPdfjs();
        // pdf.js detaches the buffer it is handed — copy so the caller's
        // ArrayBuffer survives a re-render.
        const bytes = new Uint8Array(data).slice();
        doc = await pdfjs.getDocument({ data: bytes, ...PDF_DOC_OPTIONS }).promise;
        if (cancelled) { doc.destroy(); return; }
        docRef.current = doc;

        const sizes: { width: number; height: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ width: vp.width, height: vp.height });
        }
        if (!cancelled) setPages(sizes);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err) || "");
      }
    })();

    return () => {
      cancelled = true;
      docRef.current = null;
      if (doc) { try { doc.destroy(); } catch { /* noop */ } }
    };
  }, [data]);

  // Rasterise on visibility. Each canvas carries its page number and a
  // `data-rendered` flag so a scroll-back doesn't redraw what is already there.
  useEffect(() => {
    if (pages.length === 0 || !containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const canvas = entry.target as HTMLCanvasElement;
          if (canvas.dataset.rendered) continue;
          canvas.dataset.rendered = "1";
          void renderPage(canvas, Number(canvas.dataset.page));
        }
      },
      { root: containerRef.current, rootMargin: "200px 0px" },
    );

    const canvases = containerRef.current.querySelectorAll("canvas[data-page]");
    canvases.forEach((c) => observer.observe(c));
    return () => observer.disconnect();
  }, [pages]);

  // Jump to the first page of the selected range once the layout exists.
  useEffect(() => {
    if (startPage === undefined || pages.length === 0 || !containerRef.current) return;
    const target = containerRef.current.querySelector(`[data-page-wrap="${startPage}"]`);
    if (target) (target as HTMLElement).scrollIntoView({ block: "start" });
  }, [pages, startPage]);

  async function renderPage(canvas: HTMLCanvasElement, pageNum: number) {
    const doc = docRef.current;
    if (!doc) return;
    try {
      const page = await doc.getPage(pageNum);
      const cssWidth = canvas.clientWidth;
      if (cssWidth === 0) { delete canvas.dataset.rendered; return; }
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch {
      // A failed page leaves its placeholder in place rather than killing the
      // whole preview.
      delete canvas.dataset.rendered;
    }
  }

  if (error !== null) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-muted-foreground gap-3">
        <Icon name="alert-circle" className="w-12 h-12" />
        <p className="text-sm font-medium">{error || (isRtl ? "تعذّر تحميل ملف PDF" : "Failed to load PDF")}</p>
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[300px]">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="w-14 h-14 rounded-xl bg-muted" />
          <div className="h-3 w-32 rounded-full bg-muted" />
          <div className="h-2.5 w-48 rounded-full bg-gray-100 dark:bg-gray-600" />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      dir={isRtl ? "rtl" : "ltr"}
      className="h-full overflow-auto bg-gray-100 dark:bg-gray-900 px-2 py-3 flex flex-col items-center gap-3"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      {pages.map((size, i) => (
        <div
          key={i}
          data-page-wrap={i + 1}
          className="w-full max-w-3xl bg-white shadow-sm rounded-sm overflow-hidden"
          // Reserve the page's real height before it rasterises so the
          // scrollbar doesn't jump as pages come in.
          style={{ aspectRatio: `${size.width} / ${size.height}` }}
        >
          <canvas data-page={i + 1} className="w-full h-full block" />
        </div>
      ))}
    </div>
  );
};

export default PdfCanvasRenderer;
