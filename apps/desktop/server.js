import 'dotenv/config';
import express from "express";
import compression from "compression";
import path from "path";


import db from './db.js';
import { securityHeaders } from '@atba3li/shared/http';
import {
  APP_ROOT,
  DEV_ORIGIN,
  DIST_DIR,
  HOST,
  NODE_ENV,
  PORT,
  PUBLIC_DIR,
  UPLOADS_DIR,
  ensureDirs,
  isDev,
} from './server/config.js';
import { refreshMustChangePassword, startAuthMaintenance } from './server/adminAuth.js';
import { backfillPageCounts } from './server/uploads.js';
import { broadcastEvent, registerEventRoutes } from './server/events.js';
import { setNewEmailCallback, startPolling } from './services/gmailPolling.js';
import { getGmailAccount } from './db.js';
import { registerAuthRoutes } from './server/routes/auth.js';
import { registerCatalogRoutes } from './server/routes/catalog.js';
import { registerFileRoutes } from './server/routes/files.js';
import { registerGmailRoutes } from './server/routes/gmail.js';
import { registerInventoryRoutes } from './server/routes/inventory.js';
import { registerJobRoutes } from './server/routes/jobs.js';
import { registerNetworkRoutes } from './server/routes/network.js';
import { registerSettingsRoutes } from './server/routes/settings.js';




// ── Allowed MIME types for upload ──
// ALLOWED_MIMES is imported from @atba3li/shared/validation (shared with the
// magic-byte matcher and covered by the validation test suite).



const app = express();

// gzip everything text-shaped. The JSON job list and the JS bundle are the two
// biggest payloads the dashboard waits on. SSE is excluded — buffering the
// event stream would hold job notifications back until the connection closed.
app.use(
  compression({
    filter: (req, res) => {
      const type = String(res.getHeader("Content-Type") || "");
      if (type.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

// Middleware — cap body sizes; uploads go through multer, not these.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// CORS for development only (allow the Vite dev server on its own port).
// Never enabled in a packaged build.
// Vite dev server runs on :3000 and proxies /api to this server on :3001.
if (isDev) {
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", DEV_ORIGIN);
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}

// Security headers middleware — static headers + the pdf.js-compatible CSP.
// Shared with the online app; see @atba3li/shared/http for the CSP rationale.
app.use(securityHeaders());

ensureDirs();
startAuthMaintenance();

// Non-blocking: page counts for jobs stored before the server computed them.
backfillPageCounts().catch((err) => console.error("❌ Backfill error:", err));


/**
 * API ROUTES
 */

// Favicon — inline SVG to avoid 404
app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#2563eb"/><text x="32" y="44" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="bold">P</text></svg>`);
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Every API surface, one group per module under server/routes/.
registerEventRoutes(app);
registerJobRoutes(app);
registerFileRoutes(app);
registerSettingsRoutes(app);
registerAuthRoutes(app);
registerNetworkRoutes(app);
registerCatalogRoutes(app);
registerInventoryRoutes(app);
registerGmailRoutes(app);





if (refreshMustChangePassword()) {
  console.warn("⚠️  Admin password is the default — operator must change it on next login.");
}








/**
 * STATIC FILE SERVING & SPA ROUTING
 */

// Serve public/ assets (notification sound, etc.)
app.use(express.static(PUBLIC_DIR));

// Serve static files in production
if (!isDev) {
  app.use(
    express.static(DIST_DIR, {
      etag: true,
      setHeaders: (res, filePath) => {
        // Vite content-hashes everything under /assets, so those can be cached
        // forever; index.html must not be, or a new build never reaches the UI.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          res.setHeader("Cache-Control", "public, max-age=86400");
        }
      },
    }),
  );
}

// Error handling middleware
app.use((err, req, res, _next) => {
  console.error("❌ Unhandled Error:", err.stack);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: isDev ? err.message : "Internal Server Error",
    });
  }
});

// SPA fallback (must be last)
if (!isDev) {
  app.use((req, res, _next) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "API endpoint not found" });
    }
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

/**
 * SERVER STARTUP
 */

app.listen(PORT, HOST, () => {
  console.log("\n🚀 Server started successfully!");
  console.log(`📦 Environment: ${NODE_ENV}`);
  console.log(`🌐 Server URL: http://${HOST}:${PORT}`);

  if (isDev) {
    console.log(`🔧 Development mode - CORS enabled for http://localhost:3000`);
    console.log(`💡 Frontend should run on port 5173 (Vite default)`);
  } else {
    console.log(`📁 Serving static files from: ${DIST_DIR}`);
  }

  console.log(`📂 Uploads directory: ${UPLOADS_DIR.replace(APP_ROOT, '.')}`);
  console.log(`💾 SQLite database: database.sqlite\n`);

  const gmailRedirectUri = process.env.GMAIL_REDIRECT_URI;
  if (!gmailRedirectUri) {
    console.warn('⚠️  GMAIL_REDIRECT_URI not set — Gmail OAuth flow will not work');
    console.warn('   Set GMAIL_REDIRECT_URI in your .env file, e.g.:');
    console.warn('   GMAIL_REDIRECT_URI=http://localhost:3001/api/gmail/callback');
  }

  // Auto-poll Gmail every 30s — broadcasts new emails to SSE clients
  setNewEmailCallback((count) => {
    broadcastEvent("gmail-new", { new: count });
  });

  const acct = getGmailAccount();
  if (acct?.is_active) {
    console.log('📬 Gmail account connected, starting auto-poll every 30s...');
    startPolling(30_000);
  }

  // Start cloud sync (background) — broadcasts newly-imported orders to SSE clients
  import('./services/cloudSync.js').then(({ startCloudSync, setNewJobCallback }) => {
    setNewJobCallback((job) => {
      broadcastEvent("cloud-job-imported", job);
    });
    startCloudSync().catch(err => {
      console.error('❌ Cloud sync startup error:', err.message);
    });
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("\n⏹️  SIGTERM received, shutting down gracefully...");
  db.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("\n⏹️  SIGINT received, shutting down gracefully...");
  db.close();
  process.exit(0);
});
