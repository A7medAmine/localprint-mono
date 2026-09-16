// Gmail intake: OAuth handshake, polling controls, the pending-email queue and
// attachment previews for the review dialog.
import fs from "fs";
import path from "path";
import {
  getSettings,
  updateSetting,
  getGmailAccount,
  disconnectGmail,
  getPendingEmails,
  restorePendingEmail,
} from "../../db.js";
import { getAuthUrl, handleCallback } from "../../services/gmailService.js";
import {
  pollGmail,
  importPendingEmails,
  discardPendingEmail,
  getPollStatus,
  restartPolling,
  startPolling,
  stopPolling,
} from "../../services/gmailPolling.js";
import { PREVIEW_CACHE_DIR } from "../config.js";
import { requireAdmin } from "../adminAuth.js";

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Attachment previews are unauthenticated (the review dialog renders them
// before a job exists), so cap them per IP.
const previewRateMap = new Map();
setInterval(() => previewRateMap.clear(), 60 * 1000).unref?.();

function checkPreviewRateLimit(ip) {
  const count = previewRateMap.get(ip) || 0;
  if (count >= 30) return false;
  previewRateMap.set(ip, count + 1);
  return true;
}

export function registerGmailRoutes(app) {
  // Get Gmail connection status
  app.get('/api/gmail/status', requireAdmin, (req, res) => {
    try {
      const account = getGmailAccount();
      res.json({
        connected: account?.is_active === 1,
        email: account?.gmail_email || '',
      });
    } catch (err) {
      console.error("❌ Error getting Gmail status:", err);
      res.status(500).json({ error: "Failed to get Gmail status" });
    }
  });

  // Start OAuth flow
  app.get('/api/gmail/auth', requireAdmin, (req, res) => {
    try {
      const redirectUri = process.env.GMAIL_REDIRECT_URI;
      if (!redirectUri) {
        return res.status(500).json({ error: 'GMAIL_REDIRECT_URI environment variable not set' });
      }
      const url = getAuthUrl(redirectUri);
      res.json({ url });
    } catch (err) {
      console.error("❌ Error getting auth URL:", err);
      res.status(500).json({ error: err.message });
    }
  });


  // OAuth callback
  app.get('/api/gmail/callback', async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) {
        return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('Authorization code required');window.close();<\/script></body></html>`);
      }
      const redirectUri = process.env.GMAIL_REDIRECT_URI;
      if (!redirectUri) {
        return res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('GMAIL_REDIRECT_URI not set');window.close();<\/script></body></html>`);
      }
      const email = await handleCallback(code, redirectUri);

      startPolling(30_000);

      const safeEmail = escapeHtml(email);
      res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Gmail connected — Atba3li</title><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;background:radial-gradient(1200px 800px at 20% 0%,#eef2ff 0%,transparent 60%),radial-gradient(1000px 700px at 100% 100%,#ecfdf5 0%,transparent 55%),#f8fafc;color:#0f172a}
  .card{width:100%;max-width:440px;background:#fff;padding:36px 32px 28px;border-radius:20px;border:1px solid #e2e8f0;box-shadow:0 20px 50px -20px rgba(15,23,42,.18);text-align:center}
  .icon{width:64px;height:64px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;border:6px solid #f0fdf4}
  .icon svg{width:32px;height:32px;stroke:#16a34a;fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
  h1{font-size:22px;font-weight:700;letter-spacing:-.01em;margin-bottom:6px}
  .email{display:inline-block;margin-top:2px;padding:4px 10px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:13px;font-weight:500}
  .sub{margin-top:14px;font-size:14px;line-height:1.55;color:#64748b}
  .actions{margin-top:22px;display:flex;flex-direction:column;gap:10px}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border-radius:12px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid transparent;transition:transform .06s ease,background .12s ease}
  .btn:active{transform:translateY(1px)}
  .btn-primary{background:#4f46e5;color:#fff}
  .btn-primary:hover{background:#4338ca}
  .btn-ghost{background:transparent;color:#475569;border-color:#e2e8f0}
  .btn-ghost:hover{background:#f8fafc}
  .hint{margin-top:16px;font-size:12px;color:#94a3b8}
  .tab-note{margin-top:8px;font-size:11px;color:#cbd5e1}
  </style></head><body>
  <div class="card">
    <div class="icon"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></div>
    <h1>Gmail connected</h1>
    <span class="email">${safeEmail}</span>
    <p class="sub">Atba3li will now pull print jobs from this inbox automatically. You can head back to the app.</p>
    <div class="actions">
      <a class="btn btn-primary" href="atba3li://return" id="returnBtn">Return to Atba3li</a>
      <button class="btn btn-ghost" id="closeBtn" type="button">Close this tab</button>
    </div>
    <p class="hint">This tab will close automatically in a few seconds.</p>
    <p class="tab-note">If the button above doesn't open the app, switch to it manually from the taskbar.</p>
  </div>
  <script>
    document.getElementById('closeBtn').addEventListener('click', function(){ window.close(); });
    // Auto-close after 4s. Modern browsers only allow window.close() on windows
    // opened by script — the OAuth flow qualifies (Google popped this tab from
    // window.open on accounts.google.com), so this usually works.
    setTimeout(function(){ try { window.close(); } catch(e) {} }, 4000);
  <\/script>
  </body></html>`);
    } catch (err) {
      console.error("❌ Error in Gmail callback:", err);
      const safeMsg = escapeHtml(err.message);
      res.status(500).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head><body><script>alert('${safeMsg.replace(/'/g, "\\'")}');window.close();<\/script></body></html>`);
    }
  });

  // Disconnect Gmail
  app.post('/api/gmail/disconnect', requireAdmin, (req, res) => {
    try {
      stopPolling();
      disconnectGmail();
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Error disconnecting Gmail:", err);
      res.status(500).json({ error: "Failed to disconnect Gmail" });
    }
  });

  // Manual poll trigger
  app.post('/api/gmail/poll', requireAdmin, async (req, res) => {
    try {
      const result = await pollGmail();
      res.json(result);
    } catch (err) {
      console.error("❌ Error polling Gmail:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cloud-sync failure signal ──
  // Status pushes to the cloud are fire-and-forget, but silently swallowing the
  // rejection meant a shop with an expired token had no way to know its customers
  // were seeing stale statuses. Warn once per minute (not per job) so a bulk
  // update of 200 rows does not flood the log.

  // ── General SSE event bus ──
  // Admin-only. EventSource cannot set an Authorization header, so this one
  // endpoint also accepts the admin token as a `?token=` query parameter; every
  // other endpoint stays header-only.

  // Poll health status
  app.get('/api/gmail/poll-status', requireAdmin, (req, res) => {
    try {
      res.json(getPollStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List pending emails (awaiting user review)
  app.get('/api/gmail/pending', requireAdmin, (req, res) => {
    try {
      const pending = getPendingEmails().map(p => ({
        ...p,
        attachment_meta: JSON.parse(p.attachment_meta || '[]'),
      }));
      res.json(pending);
    } catch (err) {
      console.error("❌ Error listing pending emails:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Import selected pending emails → create print jobs
  app.post('/api/gmail/import', requireAdmin, async (req, res) => {
    try {
      const { ids, overrides } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids array is required' });
      }
      const result = await importPendingEmails(ids, overrides || {});
      res.json(result);
    } catch (err) {
      console.error("❌ Error importing emails:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Discard a pending email (soft-delete)
  app.delete('/api/gmail/pending/:id', requireAdmin, (req, res) => {
    try {
      discardPendingEmail(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Error discarding pending email:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Restore a discarded pending email
  app.post('/api/gmail/pending/:id/restore', requireAdmin, (req, res) => {
    try {
      restorePendingEmail(parseInt(req.params.id));
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Error restoring pending email:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // In-memory rate limiter for attachment previews (30 req/min per IP)


  // Get attachment data for preview (with caching)
  app.get('/api/gmail/attachment/:pendingId/:attachmentIndex', async (req, res) => {
    try {
      const ip = req.ip || req.connection.remoteAddress;
      if (!checkPreviewRateLimit(ip)) {
        return res.status(429).json({ error: 'Too many requests — try again in a minute' });
      }

      const pendingId = parseInt(req.params.pendingId);
      const attachmentIndex = parseInt(req.params.attachmentIndex);
      const { getPendingEmailById } = await import('./db.js');
      const pending = getPendingEmailById(pendingId);
      if (!pending) return res.status(404).json({ error: 'Pending email not found' });

      const atts = pending.attachment_meta || [];
      const att = atts[attachmentIndex];
      if (!att) return res.status(404).json({ error: 'Attachment not found' });

      // Check cache first
      const safeFilename = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const cacheKey = `${pendingId}_${attachmentIndex}_${safeFilename}`;
      const cachePath = path.join(PREVIEW_CACHE_DIR, cacheKey);

      if (!fs.existsSync(PREVIEW_CACHE_DIR)) {
        fs.mkdirSync(PREVIEW_CACHE_DIR, { recursive: true });
      }

      if (fs.existsSync(cachePath)) {
        const cached = fs.readFileSync(cachePath);
        res.set('Content-Type', att.mimeType);
        res.set('Content-Disposition', `inline; filename="${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
        return res.send(cached);
      }

      const { getGmailClient } = await import('./services/gmailService.js');
      const gmail = await getGmailClient();
      const attResponse = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: pending.gmail_message_id,
        id: att.attachmentId,
      });

      const buffer = Buffer.from(attResponse.data.data, 'base64');

      // Save to cache
      fs.writeFileSync(cachePath, buffer);

      res.set('Content-Type', att.mimeType);
      res.set('Content-Disposition', `inline; filename="${att.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
      res.send(buffer);
    } catch (err) {
      console.error("❌ Error fetching attachment:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Get Gmail settings — one template per notification type, each tagged with
  // the language its substituted values should render in ("en" or "ar").
  app.get('/api/gmail/settings', requireAdmin, (req, res) => {
    try {
      const settings = getSettings();
      res.json({
        pollInterval: parseInt(settings.gmailPollInterval) || 60,
        replyTemplate: settings.gmailReplyTemplate || '',
        replyTemplateLang: settings.gmailReplyTemplateLang || 'en',
        readyTemplate: settings.gmailReadyTemplate || '',
        readyTemplateLang: settings.gmailReadyTemplateLang || 'en',
      });
    } catch (err) {
      console.error("❌ Error getting Gmail settings:", err);
      res.status(500).json({ error: "Failed to get Gmail settings" });
    }
  });

  app.post('/api/gmail/settings', requireAdmin, async (req, res) => {
    try {
      if (req.body.pollInterval) {
        updateSetting('gmailPollInterval', parseInt(req.body.pollInterval));
        restartPolling(parseInt(req.body.pollInterval) * 1000);
      }
      if (req.body.replyTemplate !== undefined) {
        updateSetting('gmailReplyTemplate', req.body.replyTemplate);
      }
      if (req.body.replyTemplateLang !== undefined) {
        const lang = req.body.replyTemplateLang === 'ar' ? 'ar' : 'en';
        updateSetting('gmailReplyTemplateLang', lang);
      }
      if (req.body.readyTemplate !== undefined) {
        updateSetting('gmailReadyTemplate', req.body.readyTemplate);
      }
      if (req.body.readyTemplateLang !== undefined) {
        const lang = req.body.readyTemplateLang === 'ar' ? 'ar' : 'en';
        updateSetting('gmailReadyTemplateLang', lang);
      }
      res.json({ success: true });
    } catch (err) {
      console.error("❌ Error saving Gmail settings:", err);
      res.status(500).json({ error: "Failed to save Gmail settings" });
    }
  });
}
