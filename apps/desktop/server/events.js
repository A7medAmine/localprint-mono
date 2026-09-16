// Server-sent events: the dashboard's live channel for new jobs, Gmail intake
// and status changes.
import { adminTokens, pruneTokens, validAdminToken } from "./adminAuth.js";

const SSE_MAX_CLIENTS = 50;
const SSE_MAX_PER_IP = 5;
const SSE_KEEPALIVE_MS = 25_000;

const sseClients = new Set();
const sseIpCounts = new Map(); // ip -> open connection count

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

export function broadcastEvent(event, data) {
  for (const client of sseClients) {
    try {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function registerEventRoutes(app) {
  app.get("/api/events", (req, res) => {
    // Header first (normal fetch clients), then the query fallback EventSource
    // needs. Both go through the same token map + prune.
    let token = validAdminToken(req);
    if (!token && typeof req.query.token === "string") {
      pruneTokens();
      const meta = adminTokens.get(req.query.token);
      if (meta) {
        meta.lastUsedAt = Date.now();
        token = req.query.token;
      }
    }
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (sseClients.size >= SSE_MAX_CLIENTS) {
      return res.status(503).end();
    }
    const ip = clientIp(req);
    if ((sseIpCounts.get(ip) || 0) >= SSE_MAX_PER_IP) {
      return res.status(503).end();
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("data: {}\n\n");

    sseClients.add(res);
    sseIpCounts.set(ip, (sseIpCounts.get(ip) || 0) + 1);

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      sseClients.delete(res);
      const left = (sseIpCounts.get(ip) || 1) - 1;
      if (left > 0) sseIpCounts.set(ip, left);
      else sseIpCounts.delete(ip);
    }

    // Comment-only keepalive: stops proxies and idle-socket timeouts from
    // silently dropping a stream that has had no events for minutes.
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, SSE_KEEPALIVE_MS);

    req.on("close", cleanup);
    res.on("close", cleanup);
  });
}
