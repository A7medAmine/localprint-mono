// Shop settings, the logo, and the cloud link they configure.
import fs from "fs";
import path from "path";
import {
  getSettings,
  updateSetting,
  getInternalState,
  setInternalState,
  getPaperTypes,
  replaceAllPaperTypes,
} from "../../db.js";
import { UPLOADS_DIR } from "../config.js";
import { requireAdmin } from "../adminAuth.js";
import { upload } from "../uploads.js";
import {
  parseCloudLink,
  pickPublicSettings,
  stripSecretSettings,
} from "../settingsView.js";
import { normalizeLocation, isShortMapLink, parseMapUrl } from "@atba3li/shared/geo";

export function registerSettingsRoutes(app) {
  // Get settings

  // Public settings — allowlisted keys only, no auth (used by the upload page)
  app.get("/api/settings", (req, res) => {
    const settings = pickPublicSettings(getSettings());
    settings.paperTypes = getPaperTypes();
    res.status(200).json(settings);
  });

  // Full settings for the admin UI — secrets stripped, admin token required
  app.get("/api/settings/admin", requireAdmin, (req, res) => {
    const settings = stripSecretSettings(getSettings());
    settings.paperTypes = getPaperTypes();
    res.status(200).json(settings);
  });

  // Probe the cloud with the given (or saved) URL + token so the operator can
  // verify credentials BEFORE saving them. The pasted link is parsed the same
  // way a save would parse it, so a storefront link tests exactly as it stores.
  app.post("/api/cloud/test", requireAdmin, async (req, res) => {
    try {
      const overrides = {};
      if (req.body?.cloudSyncUrl !== undefined) {
        overrides.url = parseCloudLink(req.body.cloudSyncUrl).baseUrl;
      }
      if (req.body?.shopApiToken !== undefined) {
        overrides.token = req.body.shopApiToken;
      }
      const { testConnection } = await import('../../services/cloudSync.js');
      res.status(200).json(await testConnection(overrides));
    } catch (err) {
      console.error("❌ Cloud connection test failed:", err);
      res.status(500).json({ ok: false, stage: 'server', message: err.message });
    }
  });

  // Run one cloud poll on demand ("Check for orders" in the Job Review panel).
  // The interval poller keeps running; this just pulls the same cycle forward so
  // the operator does not have to wait out the poll interval.
  app.post("/api/cloud/poll", requireAdmin, async (req, res) => {
    try {
      const { pollNow, isEnabled } = await import('../../services/cloudSync.js');
      if (!isEnabled()) {
        return res.status(400).json({ success: false, error: "Cloud sync is not configured" });
      }
      const imported = await pollNow();
      res.status(200).json({ success: true, imported });
    } catch (err) {
      console.error("❌ Manual cloud poll failed:", err);
      res.status(502).json({ success: false, error: err.message || "Cloud poll failed" });
    }
  });

  // ── Upload blocklist ─────────────────────────────────────────────────────
  // Thin proxies onto the cloud's shop-token blocklist API. The list lives on
  // the cloud because that is where uploads are refused; the desktop app is only
  // the operator's window onto it, so nothing is cached locally.

  app.get("/api/cloud/blocks", requireAdmin, async (req, res) => {
    try {
      const { listBlockedUploaders } = await import('../../services/cloudSync.js');
      res.status(200).json(await listBlockedUploaders());
    } catch (err) {
      console.error("\u274c Failed to list blocked uploaders:", err);
      res.status(502).json({ success: false, error: err.message || "Failed to list blocked uploaders" });
    }
  });

  app.post("/api/cloud/blocks", requireAdmin, async (req, res) => {
    const { kind, value, reason, label } = req.body || {};
    if (!kind || !String(value || '').trim()) {
      return res.status(400).json({ success: false, error: "kind and value are required" });
    }
    try {
      const { blockUploader } = await import('../../services/cloudSync.js');
      res.status(200).json(await blockUploader({ kind, value, reason, label }));
    } catch (err) {
      console.error("\u274c Failed to block uploader:", err);
      res.status(502).json({ success: false, error: err.message || "Failed to block uploader" });
    }
  });

  app.delete("/api/cloud/blocks/:id", requireAdmin, async (req, res) => {
    try {
      const { unblockUploader } = await import('../../services/cloudSync.js');
      await unblockUploader(req.params.id);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("\u274c Failed to unblock uploader:", err);
      res.status(502).json({ success: false, error: err.message || "Failed to unblock uploader" });
    }
  });

  // Turn a pasted map link into coordinates. Most links carry the position in
  // the URL and the client parses them itself; this endpoint exists for the
  // short ones (maps.app.goo.gl/...), which carry nothing until they are
  // followed. That means an outbound request, so it is admin-only and the host
  // allowlist below is the SSRF guard — a pasted "http://localhost:9000/admin"
  // must never become a request this server makes on the operator's behalf.
  const SHORT_LINK_ALLOWED_HOSTS = new Set([
    'maps.app.goo.gl', 'goo.gl', 'g.co', 'w.waze.com', 'maps.google.com',
    'www.google.com', 'google.com',
  ]);
  const MAX_REDIRECT_HOPS = 3;

  app.post("/api/settings/resolve-location-url", requireAdmin, async (req, res) => {
    const raw = String(req.body?.url || '').trim();
    if (!raw) return res.status(400).json({ success: false, error: "No URL provided" });

    // A link that already carries the position needs no network at all.
    const direct = parseMapUrl(raw);
    if (direct) return res.status(200).json({ success: true, ...direct, resolved: false });

    if (!isShortMapLink(raw)) {
      return res.status(422).json({ success: false, error: "That link has no location in it" });
    }

    let current = raw;
    try {
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        const url = new URL(current);
        if (url.protocol !== 'https:' || !SHORT_LINK_ALLOWED_HOSTS.has(url.hostname)) {
          return res.status(422).json({ success: false, error: "Unsupported map link" });
        }

        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Atba3li/1.0 (shop location resolver)' },
        });

        const next = response.headers.get('location');
        if (!next) break;
        current = new URL(next, url).toString();

        const found = parseMapUrl(current);
        if (found) return res.status(200).json({ success: true, ...found, resolved: true });
      }
    } catch (err) {
      console.error("❌ Failed to resolve map link:", err.message);
      return res.status(502).json({ success: false, error: "Could not reach the map service" });
    }

    return res.status(422).json({ success: false, error: "That link has no location in it" });
  });

  // Update settings (shop info only; paper types use dedicated endpoints)
  app.post("/api/settings", requireAdmin, (req, res) => {
    try {
      if (req.body.shopName !== undefined) {
        updateSetting('shopName', req.body.shopName);
      }
      if (req.body.paperTypes && Array.isArray(req.body.paperTypes)) {
        replaceAllPaperTypes(req.body.paperTypes);
      }
      if (req.body.pricing && typeof req.body.pricing === "object") {
        const currentSettings = getSettings();
        const newPricing = {
          colorPerPage:
            parseFloat(req.body.pricing.colorPerPage) ||
            currentSettings.pricing?.colorPerPage ||
            30.0,
          blackWhitePerPage:
            parseFloat(req.body.pricing.blackWhitePerPage) ||
            currentSettings.pricing?.blackWhitePerPage ||
            15.0,
          glossyPerPage:
            parseFloat(req.body.pricing.glossyPerPage) ||
            currentSettings.pricing?.glossyPerPage ||
            50.0,
          cardboardPerPage:
            parseFloat(req.body.pricing.cardboardPerPage) ||
            currentSettings.pricing?.cardboardPerPage ||
            40.0,
        };
        updateSetting('pricing', newPricing);
      }
      if (req.body.discounts !== undefined) {
        updateSetting('discounts', req.body.discounts);
      }
      if (req.body.phoneNumbers !== undefined) {
        updateSetting('phoneNumbers', req.body.phoneNumbers);
      }
      if (req.body.email !== undefined) {
        updateSetting('email', req.body.email);
      }
      if (req.body.address !== undefined) {
        updateSetting('address', req.body.address);
      }
      if (req.body.workingHours !== undefined) {
        updateSetting('workingHours', req.body.workingHours);
      }
      // The map pin. `null` clears it; anything that doesn't normalize into a
      // real coordinate pair is rejected outright rather than stored half-set,
      // because a bad pin sends customers to the wrong place silently.
      if (req.body.location !== undefined) {
        if (req.body.location === null) {
          updateSetting('location', null);
        } else {
          const location = normalizeLocation(req.body.location);
          if (!location) {
            return res.status(400).json({ success: false, error: "Invalid location coordinates" });
          }
          updateSetting('location', location);
        }
      }
      if (req.body.returnPolicy !== undefined) {
        updateSetting('returnPolicy', req.body.returnPolicy);
      }
      if (req.body.currency !== undefined) {
        updateSetting('currency', String(req.body.currency || ''));
      }
      // One pasted store link carries both values: the API base and the slug.
      let slugFromUrl = '';
      if (req.body.cloudSyncUrl !== undefined) {
        const parsed = parseCloudLink(req.body.cloudSyncUrl);
        updateSetting('cloudSyncUrl', parsed.baseUrl);
        slugFromUrl = parsed.slug;
        if (slugFromUrl) updateSetting('cloudShopSlug', slugFromUrl);
      }
      // Normally derived from the link above or cached by the cloud settings
      // sync; still settable by hand. A slug embedded in the pasted link wins.
      if (!slugFromUrl && req.body.cloudShopSlug !== undefined) {
        updateSetting('cloudShopSlug', parseCloudLink(req.body.cloudShopSlug).slug
          || String(req.body.cloudShopSlug || '').trim().replace(/^\/+|\/+$/g, ''));
      }
      if (req.body.shopApiToken !== undefined) {
        updateSetting('shopApiToken', req.body.shopApiToken);
      }
      if (req.body.cloudSyncPollInterval !== undefined) {
        updateSetting('cloudSyncPollInterval', req.body.cloudSyncPollInterval);
      }
      if (req.body.autoAcceptCloudJobs !== undefined) {
        updateSetting('autoAcceptCloudJobs', !!req.body.autoAcceptCloudJobs);
      }
      if (req.body.autoDeductStock !== undefined) {
        updateSetting('autoDeductStock', !!req.body.autoDeductStock);
      }
      // Printer settings — see electron/main.js for the print IPC that
      // consumes these. defaultPrinterName is a plain string (Chromium's
      // deviceName). printerDefaults is a { [printerName]: { duplexMode,
      // color, copies, collate, landscape } } map used as the starting
      // point for both Quick Print and the Options dialog.
      if (req.body.defaultPrinterName !== undefined) {
        updateSetting('defaultPrinterName', String(req.body.defaultPrinterName || ''));
      }
      if (req.body.printerDefaults !== undefined && typeof req.body.printerDefaults === 'object') {
        const clean = {};
        for (const [name, raw] of Object.entries(req.body.printerDefaults || {})) {
          if (!name || typeof raw !== 'object' || raw === null) continue;
          const duplex = ['simplex', 'shortEdge', 'longEdge'].includes(raw.duplexMode)
            ? raw.duplexMode
            : 'simplex';
          const copiesNum = Number(raw.copies);
          clean[name] = {
            duplexMode: duplex,
            color: raw.color !== false,
            copies: Number.isFinite(copiesNum) && copiesNum >= 1 ? Math.floor(copiesNum) : 1,
            collate: raw.collate !== false,
            landscape: raw.landscape === true,
          };
        }
        updateSetting('printerDefaults', clean);
      }

      const settings = stripSecretSettings(getSettings());
      settings.paperTypes = getPaperTypes();
      res.status(200).json({ success: true, settings });

      // Restart cloud sync if config changed
      import('../../services/cloudSync.js').then(({ stopCloudSync, startCloudSync }) => {
        stopCloudSync();
        startCloudSync().catch(() => {});
      }).catch(() => {});
    } catch (err) {
      console.error("❌ Settings update error:", err);
      res
        .status(500)
        .json({ success: false, error: "Failed to update settings" });
    }
  });

  // Upload logo
  app.post("/api/settings/logo", requireAdmin, upload.single("logo"), (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      }

      const oldFilename = getInternalState('_logo_filename');
      if (oldFilename) {
        const oldPath = path.join(UPLOADS_DIR, oldFilename);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch { console.warn("⚠️  Could not delete old logo"); }
        }
      }

      setInternalState('_logo_filename', req.file.filename);
      const logoUrl = `/api/logo`;
      updateSetting('logoUrl', logoUrl);
      res.status(200).json({ success: true, logoUrl });
    } catch (err) {
      console.error("❌ Logo upload error:", err);
      res.status(400).json({ success: false, error: err.message });
    }
  });
}
