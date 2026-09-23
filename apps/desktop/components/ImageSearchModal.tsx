import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLanguage } from "../lib/useLanguage";
import { readPref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";
import { Icon } from "./ui/icon";

interface ImageCandidate {
  id: string;
  url: string;
  thumbnail: string;
  title: string;
  sourcePage: string;
  width: number | null;
  height: number | null;
  engine: string;
}

interface FetchedImage {
  id: string;
  filename: string;
  width: number;
  height: number;
}

interface ImageSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (files: File[]) => void;
}

// Module-level so results survive the modal being unmounted (switching Print
// Studio tools) and repeated searches for the same term never re-hit the
// network — "go back to it" without waiting on SearXNG again.
interface CachedSearch {
  label: string; // original casing, for display in the history list
  results: ImageCandidate[];
  window: number;
  exhausted: boolean;
}
const searchResultCache = new Map<string, CachedSearch>();
// Most-recent-first list of past search words, so the admin can jump back to
// an earlier search without retyping or re-querying SearXNG.
const searchHistory: string[] = [];
let lastQuery = "";

function rememberHistory(key: string) {
  const idx = searchHistory.indexOf(key);
  if (idx !== -1) searchHistory.splice(idx, 1);
  searchHistory.unshift(key);
  if (searchHistory.length > 12) searchHistory.length = 12;
}

function authHeaders(): Record<string, string> {
  const token = readPref("adminToken");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function extFromFilename(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "jpg";
}

function mimeForExt(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

const ImageSearchModal: React.FC<ImageSearchModalProps> = ({ isOpen, onClose, onAdd }) => {
  const { t, lang } = useLanguage();
  const isRtl = lang === "ar";

  const [query, setQuery] = useState(lastQuery);
  const [results, setResults] = useState<ImageCandidate[]>(() => (lastQuery ? searchResultCache.get(lastQuery.toLowerCase())?.results || [] : []));
  const [window_, setWindow] = useState(() => (lastQuery ? searchResultCache.get(lastQuery.toLowerCase())?.window ?? 0 : 0));
  const [exhausted, setExhausted] = useState(() => (lastQuery ? searchResultCache.get(lastQuery.toLowerCase())?.exhausted ?? false : false));
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Map<string, ImageCandidate>>(new Map());
  const [previewCandidate, setPreviewCandidate] = useState<ImageCandidate | null>(null);
  // Bumped whenever searchHistory (module-level) changes, to force this
  // component to re-render the history chips.
  const [, setHistoryTick] = useState(0);

  // Restores the last search when the modal remounts (e.g. after switching
  // Print Studio tools and coming back) rather than starting blank.
  useEffect(() => {
    if (!isOpen || query || !lastQuery) return;
    const cached = searchResultCache.get(lastQuery.toLowerCase());
    setQuery(lastQuery);
    if (cached) {
      setResults(cached.results);
      setWindow(cached.window);
      setExhausted(cached.exhausted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const runSearch = useCallback(async (q: string, win: number, append: boolean) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setSearching(true);
    setError("");
    try {
      const res = await fetch(`/api/research/images/search?q=${encodeURIComponent(trimmed)}&window=${win}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Search failed");
      setResults((prev) => {
        const merged = append ? [...prev, ...(data.results || [])] : data.results || [];
        searchResultCache.set(trimmed.toLowerCase(), { label: trimmed, results: merged, window: win, exhausted: !!data.exhausted });
        return merged;
      });
      setWindow(win);
      setExhausted(!!data.exhausted);
      lastQuery = trimmed;
      rememberHistory(trimmed.toLowerCase());
      setHistoryTick((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e) || "Search failed");
    } finally {
      setSearching(false);
    }
  }, []);

  // Loads a query's results — from cache when we have them (instant, no
  // network), otherwise fetches fresh. Used by the search button, Enter key,
  // and clicking a history chip.
  const loadQuery = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuery(trimmed);
    setSelected(new Map());
    setError("");
    const cached = searchResultCache.get(trimmed.toLowerCase());
    if (cached) {
      setResults(cached.results);
      setWindow(cached.window);
      setExhausted(cached.exhausted);
      lastQuery = trimmed;
      rememberHistory(trimmed.toLowerCase());
      setHistoryTick((n) => n + 1);
      return;
    }
    runSearch(trimmed, 0, false);
  };

  const handleSearch = () => loadQuery(query);

  // Bypasses the cache — a fresh pull for the same term.
  const handleRefresh = () => {
    if (!query.trim()) return;
    setSelected(new Map());
    runSearch(query, 0, false);
  };

  const handleLoadMore = () => runSearch(query, window_ + 1, true);

  const toggle = (candidate: ImageCandidate) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.set(candidate.id, candidate);
      return next;
    });
  };

  const handleAdd = useCallback(async () => {
    const candidates = Array.from(selected.values());
    if (candidates.length === 0) return;
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/print-studio/images/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ candidates }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to fetch images");
      const fetched: FetchedImage[] = data.images || [];
      if (fetched.length === 0) {
        throw new Error(data.failures?.[0]?.error || "None of the selected images could be downloaded");
      }
      const files: File[] = [];
      for (const img of fetched) {
        const fileRes = await fetch(`/api/print-studio/images/file/${encodeURIComponent(img.filename)}`, {
          headers: authHeaders(),
        });
        if (!fileRes.ok) continue;
        const blob = await fileRes.blob();
        const ext = extFromFilename(img.filename);
        files.push(new File([blob], `search-${img.id}.${ext}`, { type: mimeForExt(ext) }));
      }
      if (files.length === 0) throw new Error("Failed to download the selected images");
      onAdd(files);
      onClose();
      // Results/query stay cached — reopening the modal shows the same
      // search so the admin can keep picking without searching again.
      setSelected(new Map());
    } catch (e) {
      setError(errorMessage(e) || "Failed to add images");
    } finally {
      setAdding(false);
    }
  }, [selected, onAdd, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60">
      <button type="button" className="absolute inset-0 cursor-default" aria-label={t("close")} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative bg-card rounded-xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-border w-full max-w-3xl max-h-[85vh] flex flex-col mx-4"
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-semibold text-foreground">{t("searchImages")}</h2>
          <button className="text-muted-foreground hover:text-muted-foreground text-xl leading-none" onClick={onClose}>&times;</button>
        </div>

        <div className="p-4 border-b border-border flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            placeholder={t("searchImagesPlaceholder")}
            className="flex-1 h-9 px-3 rounded-lg border border-input bg-background text-sm"
            dir={isRtl ? "rtl" : "ltr"}
          />
          {results.length > 0 && query.trim() && (
            <button
              onClick={handleRefresh}
              disabled={searching}
              title={t("refreshResults")}
              className="w-9 h-9 flex items-center justify-center text-muted-foreground hover:bg-muted rounded-lg transition disabled:opacity-50"
            >
              &#8635;
            </button>
          )}
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="px-4 h-9 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
          >
            {searching ? t("loading") : t("search")}
          </button>
        </div>

        {searchHistory.length > 0 && (
          <div className="px-4 pt-2.5 pb-1 border-b border-border flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground me-1">{t("recentSearches")}</span>
            {searchHistory.map((key) => {
              const cached = searchResultCache.get(key);
              if (!cached) return null;
              const active = key === query.trim().toLowerCase();
              return (
                <button
                  key={key}
                  onClick={() => loadQuery(cached.label)}
                  className={`px-2 py-0.5 rounded-full text-xs transition ${
                    active ? "bg-indigo-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {cached.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {error && <div className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</div>}
          {results.length === 0 && !searching ? (
            <div className="text-center text-muted-foreground py-12 text-sm">{t("noImageResults")}</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {results.map((candidate) => {
                const isSelected = selected.has(candidate.id);
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => toggle(candidate)}
                    className={`relative rounded-lg overflow-hidden border-2 transition text-start ${
                      isSelected ? "border-indigo-600" : "border-transparent hover:border-border"
                    }`}
                  >
                    <img
                      src={candidate.thumbnail}
                      alt={candidate.title}
                      loading="lazy"
                      className="w-full h-28 object-cover bg-muted"
                      onError={(e) => { e.currentTarget.style.opacity = "0.2"; }}
                    />
                    {isSelected && (
                      <span className="absolute top-1.5 end-1.5 w-5 h-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center">
                        &#10003;
                      </span>
                    )}
                    <span
                      role="button"
                      tabIndex={0}
                      title={t("preview")}
                      onClick={(e) => { e.stopPropagation(); setPreviewCandidate(candidate); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setPreviewCandidate(candidate); } }}
                      className="absolute top-1.5 start-1.5 w-7 h-7 rounded-full flex items-center justify-center cursor-pointer bg-black/60 text-white shadow-sm hover:bg-black/80 border border-white/40"
                    >
                      <Icon name="eye" className="w-4 h-4" />
                    </span>
                    {candidate.title && (
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-1.5 py-1 truncate">
                        {candidate.title}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {results.length > 0 && !exhausted && (
            <div className="text-center mt-4">
              <button
                onClick={handleLoadMore}
                disabled={searching}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted rounded-lg transition disabled:opacity-50"
              >
                {searching ? t("loading") : t("loadMore")}
              </button>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border flex items-center justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted rounded-lg transition">
            {t("cancel")}
          </button>
          <button
            onClick={handleAdd}
            disabled={selected.size === 0 || adding}
            className="px-4 py-2 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
          >
            {adding ? t("loading") : `${t("addSelectedImages")} (${selected.size})`}
          </button>
        </div>
      </div>

      {previewCandidate && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewCandidate(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="relative max-w-3xl max-h-full bg-card rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewCandidate.url}
              alt={previewCandidate.title}
              className="max-w-full max-h-[70vh] object-contain bg-black/5"
              onError={(e) => { e.currentTarget.src = previewCandidate.thumbnail; }}
            />
            <div className="p-3 border-t border-border flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs text-muted-foreground truncate">
                {previewCandidate.title}
                {previewCandidate.width && previewCandidate.height && ` · ${previewCandidate.width}×${previewCandidate.height}`}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => setPreviewCandidate(null)} className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted rounded-lg transition">
                  {t("close")}
                </button>
                <button
                  onClick={() => { toggle(previewCandidate); setPreviewCandidate(null); }}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition"
                >
                  {selected.has(previewCandidate.id) ? t("deselect") : t("select")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};

export default ImageSearchModal;
