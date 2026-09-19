-- 30-day disk cache of the filtered/ranked image-search candidates per
-- normalized query, so the relentlessly-repeated school topics (التلوث,
-- الإنترنت, الماء, ...) skip the SearXNG round trip entirely. Only the
-- filtered top 30-50 candidates are stored, never the raw ~265 results.
CREATE TABLE IF NOT EXISTS image_search_cache (
  queryHash  TEXT PRIMARY KEY,
  query      TEXT NOT NULL,
  results    TEXT NOT NULL,
  fetchedAt  DATETIME DEFAULT CURRENT_TIMESTAMP
);
