import React, { useState, useCallback } from "react";
import { Icon } from "../../ui/icon";

interface ImageRendererProps {
  src: string;
  fileName: string;
  isRtl?: boolean;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

const ImageRenderer: React.FC<ImageRendererProps> = ({ src, fileName, isRtl }) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    },
    [zoom, pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    },
    [isPanning, panStart],
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-muted-foreground gap-3">
        <Icon name="alert-circle" className="w-12 h-12" />
        <p className="text-sm font-medium">{isRtl ? "تعذّر تحميل الصورة" : "Failed to load image"}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span dir="ltr" className="text-xs font-medium text-muted-foreground min-w-[3rem] text-center">
          {Math.round(zoom * 100)}%
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title={isRtl ? "تصغير" : "Zoom out"}
            aria-label={isRtl ? "تصغير" : "Zoom out"}
          >
            <Icon name="minus" className="w-4 h-4" />
          </button>
          <button
            onClick={resetZoom}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors text-xs font-medium min-w-[2.5rem]"
            title={isRtl ? "إعادة الضبط" : "Reset zoom"}
          >
            {isRtl ? "ملائمة" : "Fit"}
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="p-1.5 rounded-lg hover:bg-muted disabled:opacity-30 transition-colors"
            title={isRtl ? "تكبير" : "Zoom in"}
            aria-label={isRtl ? "تكبير" : "Zoom in"}
          >
            <Icon name="plus" className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden bg-gray-50/50 dark:bg-gray-900/50 relative"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: zoom > 1 ? (isPanning ? "grabbing" : "grab") : "default" }}
      >
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        )}
        <div className="flex items-center justify-center w-full h-full p-4">
          <img
            src={src}
            alt={fileName}
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
            style={{
              transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              transition: isPanning ? "none" : "transform 0.15s ease-out",
            }}
            className="drop-shadow-lg dark:drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)] rounded-lg"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
};

export default ImageRenderer;
