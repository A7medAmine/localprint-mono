// Client for the shop's private SearXNG instance (image search only). Server
// -side only: the gateway API key lives in settings and must never reach the
// renderer — see server/providerConfig.js's getImageSearchConfig().
//
// SearXNG has no result-limit parameter: one query returns everything every
// enabled image engine found for that page (~265 results, ~900ms). Limiting
// to print-quality results is entirely our job, and the order matters:
//
//   filter -> rank -> slice
//
// Slicing first leaves the operator fifteen icons and logos, since most junk
// sorts arbitrarily by whatever order the engines merged in.
//
// Two independent caches sit on top of the raw search:
//   - an in-memory 10-minute window cache (this file) so "refresh for new
//     ones" is instant and never repeats an image in a row within a session;
//   - a 30-day SQLite cache (db.js: image_search_cache) so the same school
//     topic (التلوث, الإنترنت, الماء, ...) searched next September, or by a
//     different operator, skips the network call entirely.
import { createHash } from "crypto";
import { getImageSearchConfig } from "../providerConfig.js";
import { getImageSearchCache, setImageSearchCache } from "../../db.js";

const SEARXNG_TIMEOUT_MS = 10_000;
const MIN_WIDTH = 900;
const WINDOW_SIZE = 15;
const MEMORY_TTL_MS = 10 * 60 * 1000;
const DISK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DISK_CACHE_SIZE = 50;

// Hotlink-hostile or junk hosts. Matches the exact host or any subdomain of it.
const BLOCKED_HOSTS = [
  "lookaside.fbsbx.com",
  "pinimg.com",
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
];

function isBlockedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

// SearXNG's "resolution" field looks like "1920×1080" (real × sign) but some
// engines send an ASCII "x". Treat it as a hint only — never as truth (per
// spec: "resolution is frequently missing, especially from google cse
// images" and real downloads must re-decode dimensions themselves).
function parseResolution(resolution) {
  if (!resolution || typeof resolution !== "string") return { width: null, height: null };
  const match = resolution.match(/(\d+)\s*[×x]\s*(\d+)/i);
  if (!match) return { width: null, height: null };
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { width: null, height: null };
  return { width, height };
}

/** Stable id for a candidate, derived from img_src so selection survives a refresh. */
function candidateId(imgSrc) {
  return createHash("sha1").update(imgSrc).digest("hex").slice(0, 20);
}

// Normalizes SearXNG's raw result shape into ImageCandidate, dropping
// anything that fails the print-quality filter. Never returns SearXNG's raw
// JSON to a caller.
function normalizeAndFilter(rawResults) {
  const out = [];
  for (const r of Array.isArray(rawResults) ? rawResults : []) {
    const imgSrc = typeof r?.img_src === "string" ? r.img_src.trim() : "";
    if (!imgSrc) continue;

    let hostname;
    try {
      hostname = new URL(imgSrc).hostname;
    } catch {
      continue; // not a usable absolute URL
    }
    if (isBlockedHost(hostname)) continue;

    const format = String(r.img_format || "").toLowerCase();
    if (format === "svg" || /\.svg(\?|$)/i.test(imgSrc)) continue;

    const { width, height } = parseResolution(r.resolution);
    if (width != null && width < MIN_WIDTH) continue;

    out.push({
      id: candidateId(imgSrc),
      url: imgSrc,
      thumbnail: typeof r.thumbnail_src === "string" && r.thumbnail_src ? r.thumbnail_src : imgSrc,
      title: String(r.title || "").trim(),
      sourcePage: typeof r.url === "string" ? r.url : "",
      width,
      height,
      engine: String(r.engine || ""),
    });
  }
  return out;
}

function isGoogleEngine(engine) {
  return String(engine || "").toLowerCase().startsWith("google");
}

// Google results first (shop asked to prioritize them), then rank by width
// descending; results missing a resolution hint are pushed behind ones that
// have it (never truth, but better than nothing); a mild preference for
// wikicommons.images breaks ties, since licensing matters to the shop when
// two results are otherwise equivalent.
function rankCompare(a, b) {
  const aGoogle = isGoogleEngine(a.engine) ? 1 : 0;
  const bGoogle = isGoogleEngine(b.engine) ? 1 : 0;
  if (aGoogle !== bGoogle) return bGoogle - aGoogle;
  const aHas = a.width != null;
  const bHas = b.width != null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && bHas && a.width !== b.width) return b.width - a.width;
  const aWiki = a.engine === "wikicommons.images" ? 1 : 0;
  const bWiki = b.engine === "wikicommons.images" ? 1 : 0;
  return bWiki - aWiki;
}

function dedupeById(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

async function fetchSearxPage(query, page, config) {
  const url = new URL("/search", config.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("categories", "images");
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  if (page && page > 1) url.searchParams.set("pageno", String(page));

  let response;
  try {
    response = await fetch(url, {
      headers: { "X-Api-Key": config.apiKey },
      signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach the image search gateway: ${err.message || "network error"}`);
  }
  if (!response.ok) {
    throw new Error(`Image search gateway request failed (${response.status})`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Image search gateway returned a response that was not valid JSON");
  }
  return Array.isArray(payload?.results) ? payload.results : [];
}

// Fetches one SearXNG page and returns the full filter+rank pipeline
// (unsliced) — the shared building block behind both `searchImages` and the
// windowing cache below.
async function fetchAndRank(query, page, config) {
  const raw = await fetchSearxPage(query, page, config);
  const candidates = dedupeById(normalizeAndFilter(raw));
  candidates.sort(rankCompare);
  return candidates;
}

/**
 * One page of print-quality image results: filter -> rank -> slice(limit).
 * This is the low-level primitive; `getImageSearchWindow` below is what the
 * route actually calls for "refresh for new ones" windowing + caching.
 */
export async function searchImages({ query, page = 1, limit = 15 }) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  const config = getImageSearchConfig();
  if (!config) {
    throw new Error("Image search is not configured — set the SearXNG gateway in Settings");
  }
  const ranked = await fetchAndRank(q, page, config);
  return ranked.slice(0, Math.max(0, limit));
}

function normalizeQuery(query) {
  return String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function queryHash(normalizedQuery) {
  return createHash("sha1").update(normalizedQuery).digest("hex");
}

// query hash -> { candidates: ImageCandidate[], fetchedPages: Set<number>, fetchedAt: number }
const windowCache = new Map();

/**
 * "Refresh for new ones" windowing. Keeps the full filtered+ranked candidate
 * list for a query in memory for 10 minutes and serves successive 15-result
 * windows from it: window 0 -> results 1-15, window 1 -> 16-30, and so on.
 * When a requested window runs past what's cached, fetches SearXNG's
 * pageno=2 for genuinely new material; if that's exhausted too, wraps back
 * to the start and reports it so the UI can say so.
 *
 * Also the entry point for the 30-day disk cache: the first fetch for a
 * query checks (and refreshes) the SQLite cache before hitting the network.
 */
export async function getImageSearchWindow({ query, window = 0 }) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query is required");
  const config = getImageSearchConfig();
  if (!config) {
    throw new Error("Image search is not configured — set the SearXNG gateway in Settings");
  }

  const normalized = normalizeQuery(q);
  const hash = queryHash(normalized);
  const win = Math.max(0, Math.floor(Number(window) || 0));
  const offset = win * WINDOW_SIZE;
  const now = Date.now();

  let entry = windowCache.get(hash);
  if (!entry || now - entry.fetchedAt > MEMORY_TTL_MS) {
    const disk = getImageSearchCache(hash);
    const diskFresh = disk && now - new Date(disk.fetchedAt).getTime() < DISK_TTL_MS;
    if (diskFresh && Array.isArray(disk.results) && disk.results.length > 0) {
      entry = { candidates: disk.results, fetchedPages: new Set([1]), fetchedAt: now };
    } else {
      const ranked = await fetchAndRank(normalized, 1, config);
      entry = { candidates: ranked, fetchedPages: new Set([1]), fetchedAt: now };
      setImageSearchCache(hash, q, ranked.slice(0, DISK_CACHE_SIZE));
    }
    windowCache.set(hash, entry);
  }

  // Grow the pool with SearXNG's page 2 once this window runs past what we
  // have and we haven't already tried page 2 for this query.
  if (offset + WINDOW_SIZE > entry.candidates.length && !entry.fetchedPages.has(2)) {
    entry.fetchedPages.add(2);
    try {
      const more = await fetchAndRank(normalized, 2, config);
      entry.candidates = dedupeById([...entry.candidates, ...more]);
    } catch {
      // Page 2 failing is not fatal — we still have page 1's pool to wrap
      // around on below.
    }
  }

  if (entry.candidates.length === 0) {
    return { results: [], window: win, exhausted: true };
  }

  let wrapped = false;
  let start = offset % entry.candidates.length;
  if (offset >= entry.candidates.length) wrapped = true;

  let results = entry.candidates.slice(start, start + WINDOW_SIZE);
  if (results.length < WINDOW_SIZE) {
    // Ran off the end of the pool — wrap into the front to fill the window.
    const need = WINDOW_SIZE - results.length;
    const wrap = entry.candidates.slice(0, need);
    if (wrap.length > 0) wrapped = true;
    results = [...results, ...wrap];
  }

  return { results, window: win, exhausted: wrapped };
}
