import React, { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon, Spinner } from "./ui/icon";
import { storageService } from "../services/storageService";
import { errorMessage } from "@atba3li/shared";
import type { ResearchImageCandidate } from "../types";

export interface ResearchImagePickerDialogProps {
  open: boolean;
  isRtl: boolean;
  /** Prefilled from the section's (or document's) imageQuery — still editable. */
  initialQuery: string;
  onClose: () => void;
  /** Downloads the selected candidates onto the paper. Returns per-image failures. */
  onAttach: (candidates: ResearchImageCandidate[]) => Promise<{ failures: { id?: string; url?: string; error: string }[] }>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 15-candidate grid, editable query, "next 15" windowing (phase 3), multi-select
 * with a running count, and per-image download failures shown inline next to
 * the offending thumbnail — never as one generic error.
 */
const ResearchImagePickerDialog: React.FC<ResearchImagePickerDialogProps> = ({ open, isRtl, initialQuery, onClose, onAttach }) => {
  const [query, setQuery] = useState(initialQuery);
  const [windowIndex, setWindowIndex] = useState(0);
  const [results, setResults] = useState<ResearchImageCandidate[]>([]);
  const [wrapped, setWrapped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<Map<string, ResearchImageCandidate>>(new Map());
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [attaching, setAttaching] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setWindowIndex(0);
    setResults([]);
    setWrapped(false);
    setSelected(new Map());
    setFailures(new Map());
    setLoadError("");
    void runSearch(initialQuery, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialQuery]);

  const runSearch = async (q: string, win: number) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const myRequest = ++requestId.current;
    setLoading(true);
    setLoadError("");
    try {
      const res = await storageService.searchResearchImages(trimmed, win);
      if (myRequest !== requestId.current) return;
      setResults(res.results);
      setWrapped(!!res.exhausted && win > 0);
      setWindowIndex(res.window);
    } catch (err) {
      if (myRequest !== requestId.current) return;
      setLoadError(errorMessage(err) || (isRtl ? "تعذّر جلب الصور" : "Could not fetch images"));
      setResults([]);
    } finally {
      if (myRequest === requestId.current) setLoading(false);
    }
  };

  const handleSearch = () => {
    setSelected(new Map());
    setFailures(new Map());
    void runSearch(query, 0);
  };

  const handleRefresh = () => {
    setFailures(new Map());
    void runSearch(query, windowIndex + 1);
  };

  const toggle = (candidate: ResearchImageCandidate) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.set(candidate.id, candidate);
      return next;
    });
  };

  const handleAttach = async () => {
    if (selected.size === 0 || attaching) return;
    setAttaching(true);
    try {
      const { failures: failed } = await onAttach(Array.from(selected.values()));
      if (!failed || failed.length === 0) {
        onClose();
        return;
      }
      const failMap = new Map<string, string>();
      failed.forEach((f) => { if (f.id) failMap.set(f.id, f.error); });
      setFailures(failMap);
      // Keep only the failed ones selected — the successful ones are already
      // attached, and the operator can immediately pick replacements for the rest.
      setSelected((prev) => {
        const next = new Map<string, ResearchImageCandidate>();
        prev.forEach((c, id) => { if (failMap.has(id)) next.set(id, c); });
        return next;
      });
    } catch (err) {
      setLoadError(errorMessage(err) || (isRtl ? "تعذّرت إضافة الصور" : "Could not attach images"));
    } finally {
      setAttaching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isRtl ? "اختيار الصور" : "Pick images"}</DialogTitle>
          <DialogDescription>
            {isRtl
              ? "عدّل كلمات البحث إذا لزم، اختر عدة صور، ثم أضفها إلى البحث."
              : "Edit the search terms if needed, select several images, then attach them."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSearch(); } }}
              placeholder={isRtl ? "كلمات البحث عن الصورة (إنجليزي أفضل)" : "Image search terms"}
              dir="ltr"
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={handleSearch} disabled={loading} className="gap-1.5 shrink-0">
              <Icon name="search" className="w-4 h-4" />
              {isRtl ? "بحث" : "Search"}
            </Button>
            <Button type="button" variant="outline" onClick={handleRefresh} disabled={loading || !query.trim()} className="gap-1.5 shrink-0">
              {loading ? <Spinner className="w-4 h-4" /> : <Icon name="refresh" className="w-4 h-4" />}
              {isRtl ? "تحديث" : "Refresh"}
            </Button>
          </div>

          {wrapped && (
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
              <Icon name="info" className="w-3.5 h-3.5 shrink-0" />
              {isRtl ? "رجعنا إلى أول النتائج — ما فماش صور جديدة أكثر." : "Back to the first results — no more new ones."}
            </p>
          )}

          {loadError && (
            <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
          )}

          {loading && results.length === 0 ? (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {Array.from({ length: 15 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {isRtl ? "لا توجد نتائج — جرّب كلمات بحث أخرى" : "No results — try different search terms"}
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {results.map((c) => {
                const isSelected = selected.has(c.id);
                const failure = failures.get(c.id);
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => toggle(c)}
                    className={`relative rounded-lg overflow-hidden border-2 text-start transition-colors ${
                      failure
                        ? "border-red-500"
                        : isSelected
                        ? "border-indigo-600"
                        : "border-transparent hover:border-border"
                    }`}
                  >
                    <div className="aspect-square bg-muted overflow-hidden">
                      <img src={c.thumbnail || c.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    </div>
                    {isSelected && !failure && (
                      <div className="absolute top-1 end-1 w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center">
                        <Icon name="check" className="w-3 h-3" />
                      </div>
                    )}
                    <div className="px-1.5 py-1 bg-black/55 text-white text-[10px] leading-tight" dir="ltr">
                      <div className="truncate">{c.width && c.height ? `${c.width}×${c.height}` : (isRtl ? "دقة غير معروفة" : "unknown res.")}</div>
                      <div className="truncate opacity-80">{hostOf(c.sourcePage || c.url)}</div>
                    </div>
                    {failure && (
                      <div className="px-1.5 py-1 bg-red-600 text-white text-[10px] leading-tight" dir="auto">
                        {failure}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {isRtl ? `المحدد: ${selected.size}` : `Selected: ${selected.size}`}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{isRtl ? "إلغاء" : "Cancel"}</Button>
            <Button type="button" onClick={handleAttach} disabled={selected.size === 0 || attaching} className="gap-1.5">
              {attaching && <Spinner className="w-4 h-4" />}
              {isRtl ? "إضافة" : "Attach"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ResearchImagePickerDialog;
