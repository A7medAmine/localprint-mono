import React, { useState, useEffect, useCallback, useRef } from "react";
import { getPdfjs, PDF_DOC_OPTIONS } from "../../../lib/pdfRender";
import { Icon } from "../../ui/icon";
import { errorMessage } from "@localprint/shared";

interface PdfRendererProps {
  src: string;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

const PdfRenderer: React.FC<PdfRendererProps> = ({ src }) => {
  const [pdf, setPdf] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        setLoading(true);
        setError(null);
        const pdfjs = await getPdfjs();
        const data = await fetch(src).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        });
        if (cancelled) return;
        const doc = await pdfjs.getDocument({ data, ...PDF_DOC_OPTIONS }).promise;
        if (cancelled) return;
        setPdf(doc);
        setPageCount(doc.numPages);
        setCurrentPage(1);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err) || "Failed to load PDF");
          setLoading(false);
        }
      }
    }

    init();
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;

    async function renderPage() {
      try {
        if (renderTaskRef.current) {
          try { await renderTaskRef.current.cancel(); } catch { /* ignored */ }
        }
        const page = await pdf.getPage(currentPage);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = viewport.width * dpr;
        canvas.height = viewport.height * dpr;
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";

        ctx.scale(dpr, dpr);

        try {
          renderTaskRef.current = page.render({ canvasContext: ctx, viewport });
          await renderTaskRef.current.promise;
          renderTaskRef.current = null;
        } catch (err) {
          // pdf.js signals a superseded render by name, not by type.
          if ((err as { name?: string } | null)?.name === "RenderingCancelledException") return;
          throw err;
        }
      } catch (err) {
        if (cancelled) return;
        console.error("PdfRenderer render failed", err);
        setError(errorMessage(err) || "Failed to render PDF page");
      }
    }

    renderPage();
    return () => { cancelled = true; };
  }, [pdf, currentPage, zoom]);

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.max(1, Math.min(page, pageCount)));
    },
    [pageCount],
  );

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-muted-foreground gap-3">
        <Icon name="alert-circle" className="w-12 h-12" />
        <p className="text-sm font-medium">{error}</p>
      </div>
    );
  }

  if (loading) {
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title="Previous page"
           aria-label="Previous page">
            <Icon name="chevron-left" className="w-4 h-4" />
          </button>
          <span className="text-xs font-medium text-muted-foreground min-w-[5rem] text-center tabular-nums">
            {currentPage} / {pageCount}
          </span>
          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= pageCount}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title="Next page"
           aria-label="Next page">
            <Icon name="chevron-right" className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-muted-foreground min-w-[3rem] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title="Zoom out"
           aria-label="Zoom out">
            <Icon name="minus" className="w-4 h-4" />
          </button>
          <button
            onClick={resetZoom}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors text-xs font-medium"
            title="Reset zoom"
          >
            Fit
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title="Zoom in"
           aria-label="Zoom in">
            <Icon name="plus" className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-gray-50/50 dark:bg-gray-900/50 p-4 flex justify-center">
        <canvas ref={canvasRef} className="shadow-xl rounded-lg" />
      </div>
    </div>
  );
};

export default PdfRenderer;
