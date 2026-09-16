// HTTP middleware shared by both apps' servers. Plain .js (no TypeScript): the
// servers run under plain Node, which cannot import .ts — so this is consumed
// via the "@atba3li/shared/http" subpath export, alongside validation.js
// and pdf.js.

// ── Generic sliding-window rate limiter (per-IP) ──
// Each returned middleware keeps its own in-memory hit map and a GC interval
// that prunes IPs with no fresh hits. The per-request .filter() is what enforces
// the window; the interval only reclaims memory.
// Which address identifies the client. Behind Cloudflare, Express's own req.ip
// can resolve to a CF edge address when more than one proxy hop is in front
// (CF -> nginx -> app), which buckets EVERY customer into one shared budget and
// hands out spurious 429s. CF-Connecting-IP is the real client and Cloudflare
// overwrites any client-supplied copy — but only when the request actually came
// through CF, so trusting it is opt-in via TRUST_CF_CONNECTING_IP=1 (set it
// only if the origin is not reachable except through Cloudflare).
export function clientIp(req) {
  if (process.env.TRUST_CF_CONNECTING_IP === "1") {
    const cf = req.headers?.["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function makeRateLimiter({ windowMs, max, message, keyGenerator = clientIp }) {
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
    const ip = keyGenerator(req);
    const now = Date.now();
    const ts = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (ts.length >= max) {
      // Tell the client exactly how long the oldest hit still blocks it, so a
      // retry can be scheduled instead of guessed.
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - ts[0])) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: message || "Too many requests. Try again later.",
        retryAfter,
      });
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
export function buildContentSecurityPolicy({
  connectSrc = ["'self'", "blob:"],
  scriptSrc = [],
} = {}) {
  return (
    [
      "default-src 'self'",
      ["script-src 'self' 'wasm-unsafe-eval' blob:", ...scriptSrc].join(" "),
      "worker-src 'self' blob:",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src ${connectSrc.join(" ")}`,
      "frame-src 'self'",
    ].join("; ") + ";"
  );
}

// Express middleware setting the app-wide security headers. X-XSS-Protection is
// deprecated / harmful and omitted deliberately; the CSP is the real defence.
export function securityHeaders({ connectSrc, scriptSrc, hsts = false } = {}) {
  const csp = buildContentSecurityPolicy({
    ...(connectSrc ? { connectSrc } : {}),
    ...(scriptSrc ? { scriptSrc } : {}),
  });
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", csp);
    // Only meaningful (and only safe to promise) behind HTTPS — the online
    // app runs there in prod; the desktop app's local server does not opt in.
    if (hsts) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };
}
