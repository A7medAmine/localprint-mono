// HTTP middleware shared by both apps' servers. Plain .js (no TypeScript): the
// servers run under plain Node, which cannot import .ts — so this is consumed
// via the "@localprint/shared/http" subpath export, alongside validation.js
// and pdf.js.

// ── Generic sliding-window rate limiter (per-IP) ──
// Each returned middleware keeps its own in-memory hit map and a GC interval
// that prunes IPs with no fresh hits. The per-request .filter() is what enforces
// the window; the interval only reclaims memory.
export function makeRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of hits) {
      const fresh = ts.filter((t) => now - t < windowMs);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, Math.max(windowMs, 60_000));
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const ts = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (ts.length >= max) {
      return res.status(429).json({ error: message || "Too many requests. Try again later." });
    }
    ts.push(now);
    hits.set(ip, ts);
    next();
  };
}

// Builds the app-wide Content-Security-Policy. Only connect-src varies between
// the apps (the online app must reach Supabase); everything else is the
// pdf.js-compatible baseline.
//
// pdf.js needs: 'wasm-unsafe-eval' (openjpeg/qcms WASM) in script-src, and
// blob: in worker-src (it spins module workers from Blob URLs), img-src
// (rendered page images) and connect-src (fetches its own worker chunks as blob
// URLs on some paths). Without these, the preview + Studio thumbnails load
// metadata but silently fail at page.render() inside Electron, where this CSP is
// enforced (Vite dev bypasses it, which is why the browser dev flow looks fine).
export function buildContentSecurityPolicy({ connectSrc = ["'self'", "blob:"] } = {}) {
  return (
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' blob:",
      "worker-src 'self' blob:",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      `connect-src ${connectSrc.join(" ")}`,
      "frame-src 'self'",
    ].join("; ") + ";"
  );
}

// Express middleware setting the app-wide security headers. X-XSS-Protection is
// deprecated / harmful and omitted deliberately; the CSP is the real defence.
export function securityHeaders({ connectSrc } = {}) {
  const csp = buildContentSecurityPolicy(connectSrc ? { connectSrc } : {});
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", csp);
    next();
  };
}
