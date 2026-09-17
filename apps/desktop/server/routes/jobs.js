// Print jobs: the admin list, customer uploads, status/payment changes and
// the review queue.
import fs from "fs";
import path from "path";
import { randomBytes, randomUUID, createHash } from "crypto";
import db from "../../db.js";
import { UPLOADS_DIR } from "../config.js";
import { requireAdmin, isValidAdminToken } from "../adminAuth.js";
import { makeRateLimiter } from "@atba3li/shared/http";
import { computePageCount, upload, uploadLimit, validateMagicBytes } from "../uploads.js";
import { broadcastEvent } from "../events.js";
import { applyAutoDeductForJob } from "../inventory.js";

const hashDeleteToken = (token) => createHash("sha256").update(String(token)).digest("hex");

// "My recent uploads" only ever asks about the handful of IDs in one browser.
const MAX_QUERY_IDS = 50;
const queryLimit = makeRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: "Too many lookups. Please wait a moment.",
});

export function registerJobRoutes(app) {
  // Get all jobs (admin only)
  // Newest-first page of jobs. The dashboard filters and counts client-side, so
  // it asks for a generous page and only fetches the rest when the operator asks
  // — an unbounded SELECT here is what made the list crawl on old shop databases.
  // Status pushes to the cloud are fire-and-forget, but silently swallowing the
  // rejection meant a shop with an expired token had no way to know its customers
  // were seeing stale statuses. Warn once per minute (not per job) so a bulk
  // update of 200 rows does not flood the log.
  let lastCloudSyncWarnAt = 0;
  function warnCloudSyncFailed(count, err) {
    const now = Date.now();
    if (now - lastCloudSyncWarnAt < 60_000) return;
    lastCloudSyncWarnAt = now;
    console.warn(
      `⚠️  Cloud status sync failed for ${count} job(s): ${err?.message || err}. ` +
      `Check the shop token in Settings → Cloud.`
    );
    broadcastEvent('cloud-sync-error', { message: err?.message || String(err) });
  }

  const JOBS_PAGE_DEFAULT = 500;
  const JOBS_PAGE_MAX = 5000;

  app.get("/api/jobs", requireAdmin, (req, res) => {
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), JOBS_PAGE_MAX)
      : JOBS_PAGE_DEFAULT;
    const rawOffset = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const total = db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;
    const page = db
      .prepare('SELECT * FROM jobs ORDER BY uploadDate DESC LIMIT ? OFFSET ?')
      .all(limit, offset);

    // The review queue lives in this same payload, so a job awaiting review must
    // never fall off the end of a page — always append the ones the page missed.
    const seen = new Set(page.map((j) => j.id));
    const pendingReview = db
      .prepare("SELECT * FROM jobs WHERE status = 'pending_review' ORDER BY uploadDate DESC")
      .all()
      .filter((j) => !seen.has(j.id));
    const jobs = page.concat(pendingReview);

    res.set("X-Total-Count", String(total));
    res.set("Access-Control-Expose-Headers", "X-Total-Count");
    const formattedJobs = jobs.map(job => ({
      ...job,
      paymentAmount: job.paymentAmount || 0,
      paymentStatus: job.paymentStatus || 'UNPAID',
      printPreferences: {
        colorMode: job.colorMode,
        copies: job.copies,
        paperType: job.paperType || 'normal'
      }
    }));
    res.status(200).json(formattedJobs);
  });

  // Public query — get jobs by ID array (for "my recent uploads").
  // Unauthenticated by design: the customer's browser knows the IDs of its own
  // uploads and nothing else. IDs are random UUIDs, so they cannot be guessed,
  // but the list is capped and rate-limited so the endpoint cannot be used to
  // sweep for them either.
  app.post("/api/jobs/query", queryLimit, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(200).json([]);
    }
    if (ids.length > MAX_QUERY_IDS) {
      return res.status(400).json({ error: `At most ${MAX_QUERY_IDS} ids per query` });
    }
    if (!ids.every((id) => typeof id === "string")) {
      return res.status(400).json({ error: "ids must be strings" });
    }
    const placeholders = ids.map(() => '?').join(',');
    const jobs = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders}) ORDER BY uploadDate DESC`).all(...ids);
    const sanitized = jobs.map(job => ({
      id: job.id,
      fileName: job.fileName,
      fileType: job.fileType,
      fileSize: job.fileSize,
      uploadDate: job.uploadDate,
      status: job.status,
      pageCount: job.pageCount,
      paperType: job.paperType || 'normal',
      colorMode: job.colorMode,
      copies: job.copies,
      source: job.source,
      paymentStatus: job.paymentStatus || 'UNPAID',
      paymentAmount: job.paymentAmount || 0,
      printPreferences: {
        colorMode: job.colorMode,
        copies: job.copies,
        paperType: job.paperType || 'normal'
      },
    }));
    res.status(200).json(sanitized);
  });

  // Upload new job
  app.post("/api/upload", uploadLimit, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      }

      const metadata = JSON.parse(req.body.metadata || "{}");
      const filePath = path.join(UPLOADS_DIR, req.file.filename);

      // Validate magic bytes match the claimed MIME type
      if (!validateMagicBytes(filePath, req.file.mimetype)) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ success: false, error: "File content does not match its type" });
      }

      const pageCount = await computePageCount(filePath, req.file.mimetype, req.file.size);

      // The server owns the primary key and the delete secret — never the client.
      const id = randomUUID();
      const deleteToken = randomBytes(16).toString("hex");
      const prefs = metadata.printPreferences || {};

      const newJob = {
        id,
        // Shared by every file from one upload submission (the client sends
        // the same value for each file in a batch) so files that finish
        // uploading — and so arrive here — at different times still land in
        // one order. Falls back to the job's own id for older clients that
        // don't send it, so it still groups as a lone-file order.
        orderId: String(metadata.orderId || "").trim() || id,
        customerName: String(metadata.customerName || metadata.customer || "").trim(),
        phoneNumber: String(metadata.phoneNumber || metadata.phone || "").trim(),
        notes: String(metadata.notes || "").trim(),
        fileName: String(metadata.fileName || req.file.originalname || "upload").trim(),
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        uploadDate: new Date().toISOString(),
        status: metadata.status || "PENDING",
        serverFileName: req.file.filename,
        pageCount,
        colorMode: prefs.colorMode || metadata.colorMode || "color",
        copies: Number(prefs.copies || metadata.copies) >= 1 ? Math.floor(Number(prefs.copies || metadata.copies)) : 1,
        paperType: prefs.paperType || metadata.paperType || "normal",
        source: metadata.source || "upload",
      };

      const insertStmt = db.prepare(`
        INSERT INTO jobs (
          id, orderId, customerName, phoneNumber, notes, fileName, fileType,
          fileSize, uploadDate, status, serverFileName, pageCount,
          colorMode, copies, paperType, source, deleteTokenHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        newJob.id, newJob.orderId, newJob.customerName, newJob.phoneNumber, newJob.notes,
        newJob.fileName, newJob.fileType, newJob.fileSize, newJob.uploadDate,
        newJob.status, newJob.serverFileName, newJob.pageCount,
        newJob.colorMode, newJob.copies, newJob.paperType, newJob.source,
        hashDeleteToken(deleteToken)
      );

      broadcastEvent("new-job", { id: newJob.id });
      // deleteToken is returned exactly once — the client keeps it in localStorage.
      res.status(200).json({
        success: true,
        job: { ...newJob, printPreferences: { colorMode: newJob.colorMode, copies: newJob.copies, paperType: newJob.paperType } },
        deleteToken,
      });
    } catch (err) {
      console.error("❌ Upload Error:", err);
      res.status(400).json({ success: false, error: "Invalid upload metadata" });
    }
  });

  // Admin job create — operator-made jobs (Photo Batch save-as-job, manual job
  // entry). Authenticated, unlike the public /api/upload. The server owns the id;
  // any client-supplied id is ignored. These jobs are local-only (source: "admin"),
  // so cloudSync never touches them.
  app.post("/api/jobs", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      const metadata = JSON.parse(req.body.metadata || "{}");
      const filePath = path.join(UPLOADS_DIR, req.file.filename);

      // Magic bytes must match the claimed MIME type (validated against the
      // shared allowlist — PDF, JPEG, PNG, TIFF, DOCX, XLSX).
      if (!validateMagicBytes(filePath, req.file.mimetype)) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ success: false, error: "File content does not match its type" });
      }

      const pageCount = await computePageCount(filePath, req.file.mimetype, req.file.size);

      const id = randomUUID();
      const deleteToken = randomBytes(16).toString("hex");
      const prefs = metadata.printPreferences || {};

      const colorMode = prefs.colorMode === "blackWhite" ? "blackWhite" : "color";
      const copies = Number(prefs.copies) >= 1 ? Math.floor(Number(prefs.copies)) : 1;
      const paperType = String(prefs.paperType || "normal");
      const uploadDate = new Date().toISOString();

      const newJob = {
        id,
        orderId: id,
        customerName: String(metadata.customerName || metadata.customer || "").trim(),
        phoneNumber: String(metadata.phoneNumber || metadata.phone || "").trim(),
        notes: String(metadata.notes || "").trim(),
        fileName: String(metadata.fileName || req.file.originalname || "upload").trim(),
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        uploadDate,
        status: "PENDING",
        serverFileName: req.file.filename,
        pageCount,
        colorMode,
        copies,
        paperType,
        source: "admin",
      };

      const insertStmt = db.prepare(`
        INSERT INTO jobs (
          id, orderId, customerName, phoneNumber, notes, fileName, fileType,
          fileSize, uploadDate, status, serverFileName, pageCount,
          colorMode, copies, paperType, source, deleteTokenHash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        newJob.id, newJob.orderId, newJob.customerName, newJob.phoneNumber, newJob.notes,
        newJob.fileName, newJob.fileType, newJob.fileSize, newJob.uploadDate,
        newJob.status, newJob.serverFileName, newJob.pageCount,
        newJob.colorMode, newJob.copies, newJob.paperType, newJob.source,
        hashDeleteToken(deleteToken)
      );

      broadcastEvent("new-job", { id: newJob.id });
      res.status(200).json({
        success: true,
        job: { ...newJob, printPreferences: { colorMode: newJob.colorMode, copies: newJob.copies, paperType: newJob.paperType } },
        deleteToken,
      });
    } catch (err) {
      console.error("❌ Admin job create error:", err);
      res.status(400).json({ success: false, error: "Invalid job metadata" });
    }
  });

  // Update job file
  app.post("/api/jobs/:id/file", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      const jobId = req.params.id;
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

      if (!job) {
        return res.status(404).json({ success: false, error: "Job not found" });
      }
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      }

      // Validate magic bytes match the claimed MIME type
      const newFilePath = path.join(UPLOADS_DIR, req.file.filename);
      if (!validateMagicBytes(newFilePath, req.file.mimetype)) {
        fs.unlinkSync(newFilePath);
        return res.status(400).json({ success: false, error: "File content does not match its type" });
      }

      // Delete old file
      if (job.serverFileName) {
        const oldPath = path.join(UPLOADS_DIR, job.serverFileName);
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch {
            console.warn("⚠️  Could not delete old file");
          }
        }
      }

      const pageCount = await computePageCount(
        path.join(UPLOADS_DIR, req.file.filename),
        req.file.mimetype,
        req.file.size,
      );

      // Optional display-name update — a job whose image was replaced by a
      // processed PDF must not keep advertising the old "photo.jpg".
      const rawName = typeof req.body?.fileName === "string" ? req.body.fileName.trim() : "";
      const newFileName = rawName ? path.basename(rawName).slice(0, 255) : job.fileName;

      // Update job in DB
      const updateStmt = db.prepare(`
        UPDATE jobs
        SET serverFileName = ?, fileName = ?, fileSize = ?, fileType = ?, pageCount = ?
        WHERE id = ?
      `);
      updateStmt.run(req.file.filename, newFileName, req.file.size, req.file.mimetype, pageCount, jobId);

      const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      res.status(200).json({ success: true, job: updatedJob });
    } catch (err) {
      console.error("❌ Update File Error:", err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  // Update job status
  app.put("/api/jobs/:id/status", requireAdmin, (req, res) => {
    const { status } = req.body;
    const jobId = req.params.id;

    const previousStatus = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)?.status;
    const result = db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);

    if (result.changes > 0) {
      const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      applyAutoDeductForJob(updatedJob, previousStatus);
      res.status(200).json({ success: true, job: updatedJob });

      // Push to the cloud so the customer's upload page reflects the change
      // via the SSE stream. Fire-and-forget — no need to block the response.
      const cloudOrderId = updatedJob?.cloudOrderId;
      if (cloudOrderId) {
        import('../../services/cloudSync.js').then(({ updateCloudStatus, isEnabled }) => {
          if (isEnabled()) {
            updateCloudStatus(cloudOrderId, status).catch(err => warnCloudSyncFailed(1, err));
          }
        }).catch(err => warnCloudSyncFailed(1, err));
      }

      // Auto-notify the customer when a gmail-sourced job becomes READY.
      // Idempotent via notifiedReadyAt — safe if the admin toggles status.
      if (
        status === "READY" &&
        previousStatus !== "READY" &&
        updatedJob?.source === "gmail" &&
        updatedJob?.gmailMessageId &&
        !updatedJob?.notifiedReadyAt
      ) {
        import('../../services/gmailNotifier.js')
          .then(({ sendJobReadyNotification }) => sendJobReadyNotification(jobId))
          .then((r) => {
            if (r.sent) console.log(`  📧 Ready notification sent for job ${jobId}`);
            else if (r.reason !== "already_notified") console.warn(`⚠️  Ready notification skipped for ${jobId}: ${r.reason}`);
          })
          .catch((err) => console.warn(`⚠️  Ready notification failed for ${jobId}:`, err.message));
      }
    } else {
      res.status(404).json({ success: false, error: "Job not found" });
    }
  });

  // Manual re-send of the "ready" notification (admin can force from the UI
  // if the automatic send failed or the template was updated afterwards).
  app.post("/api/jobs/:id/notify-ready", requireAdmin, async (req, res) => {
    try {
      const { sendJobReadyNotification } = await import('../../services/gmailNotifier.js');
      const result = await sendJobReadyNotification(req.params.id, { force: true });
      if (result.sent) return res.json({ success: true });
      res.status(400).json({ success: false, error: result.reason });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Update job print preferences (colorMode, copies)
  app.put("/api/jobs/:id/preferences", requireAdmin, (req, res) => {
    const jobId = req.params.id;
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  
    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    const { colorMode, copies, paperType } = req.body;
    let finalColorMode = job.colorMode;
    let finalCopies = job.copies;
    let finalPaperType = job.paperType || 'normal';

    if (colorMode === "color" || colorMode === "blackWhite") {
      finalColorMode = colorMode;
    }

    const parsedCopies = parseInt(copies, 10);
    if (!isNaN(parsedCopies) && parsedCopies >= 1 && parsedCopies <= 100) {
      finalCopies = parsedCopies;
    }

    if (paperType && typeof paperType === 'string') {
      finalPaperType = paperType;
    }

    db.prepare('UPDATE jobs SET colorMode = ?, copies = ?, paperType = ? WHERE id = ?')
      .run(finalColorMode, finalCopies, finalPaperType, jobId);

    const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    console.log(
      `✏️  Updated preferences for job ${jobId}: ${finalColorMode}, ${finalCopies} cop(ies)`,
    );
    res.status(200).json({ 
      success: true, 
      job: {
        ...updatedJob,
        printPreferences: { colorMode: finalColorMode, copies: finalCopies, paperType: finalPaperType }
      } 
    });
  });

  // Delete job — customer proves ownership with the per-upload deleteToken
  // (handed back once at upload time). Admin token also works.
  app.delete("/api/jobs/:id", (req, res) => {
    const jobId = req.params.id;
    const { deleteToken } = req.body || {};

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    const isAdmin = isValidAdminToken(req);
    const tokenOk = job.deleteTokenHash && deleteToken &&
      hashDeleteToken(deleteToken) === job.deleteTokenHash;
    if (!isAdmin && !tokenOk) {
      return res.status(403).json({ success: false, error: "Not authorized to delete this job" });
    }

    const filePath = job.serverFileName ? path.join(UPLOADS_DIR, job.serverFileName) : null;
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      console.warn("⚠️  Could not delete physical file");
    }

    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    broadcastEvent("job-deleted", { id: jobId });
    res.status(200).json({ success: true });
  });

  // Accept a job awaiting review (cloud-sync jobs held back by auto_accept_cloud_jobs=false)
  app.post("/api/jobs/:id/review/accept", requireAdmin, async (req, res) => {
    try {
      const jobId = req.params.id;
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!job) return res.status(404).json({ success: false, error: "Job not found" });
      if (job.status !== 'pending_review') {
        return res.status(400).json({ success: false, error: "Job is not awaiting review" });
      }

      db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('PENDING', jobId);

      // Ack on the cloud so it stops showing up in /api/shop/pending. If this
      // fails, the next poll cycle's dedupe check will notice the job is no
      // longer pending_review and retry the ack automatically.
      import('../../services/cloudSync.js').then(({ acknowledgeOrder }) => {
        acknowledgeOrder(jobId).catch(err => console.error('❌ Failed to ack accepted review job:', err.message));
      }).catch(() => {});

      const updatedJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      broadcastEvent("new-job", { id: jobId });
      res.status(200).json({ success: true, job: updatedJob });
    } catch (err) {
      console.error("❌ Accept review error:", err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  // Reject a job awaiting review — tells the cloud why, deletes the local file/row
  app.post("/api/jobs/:id/review/reject", requireAdmin, async (req, res) => {
    try {
      const jobId = req.params.id;
      const { reason, note } = req.body;
      if (!reason) {
        return res.status(400).json({ success: false, error: "reason is required" });
      }

      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!job) return res.status(404).json({ success: false, error: "Job not found" });

      const { rejectCloudOrder } = await import('../../services/cloudSync.js');
      const rejected = await rejectCloudOrder(jobId, reason, note);
      if (!rejected) {
        console.warn(`⚠️  Cloud reject failed for ${jobId} — it may reappear for review on the next poll`);
      }

      if (job.serverFileName) {
        const filePath = path.join(UPLOADS_DIR, job.serverFileName);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { console.warn("⚠️  Could not delete rejected job's file"); }
      }

      db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("❌ Reject review error:", err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  });

  // Bulk delete jobs
  app.post("/api/jobs/bulk/delete", requireAdmin, (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No IDs provided" });
    }
    const deleteStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
    const runStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    // Collect file names inside the transaction, unlink AFTER it commits —
    // filesystem ops aren't transactional, so a throw mid-loop would otherwise
    // leave files deleted for rows that got rolled back.
    const filesToDelete = [];
    const txn = db.transaction((jobIds) => {
      for (const id of jobIds) {
        const job = deleteStmt.get(id);
        if (job) {
          if (job.serverFileName) filesToDelete.push(job.serverFileName);
          runStmt.run(id);
        }
      }
    });
    txn(ids);
    for (const name of filesToDelete) {
      const filePath = path.join(UPLOADS_DIR, name);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignored */ }
    }
    res.status(200).json({ success: true, deleted: ids.length });
  });

  // Bulk status update
  app.post("/api/jobs/bulk/status", requireAdmin, (req, res) => {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No IDs provided" });
    }
    const stmt = db.prepare('UPDATE jobs SET status = ? WHERE id = ?');
    const getStmt = db.prepare('SELECT cloudOrderId FROM jobs WHERE id = ?');
    const jobStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
    const cloudIds = [];
    // Captured inside the transaction, applied after it commits — stock changes
    // shouldn't ride on the status transaction.
    const deducts = [];
    const txn = db.transaction((jobIds) => {
      for (const id of jobIds) {
        const previousStatus = jobStmt.get(id)?.status;
        stmt.run(status, id);
        const row = getStmt.get(id);
        if (row?.cloudOrderId) cloudIds.push(row.cloudOrderId);
        deducts.push({ job: jobStmt.get(id), previousStatus });
      }
    });
    txn(ids);
    for (const { job, previousStatus } of deducts) applyAutoDeductForJob(job, previousStatus);
    res.status(200).json({ success: true, updated: ids.length });

    // Fire-and-forget cloud sync for each cloud-sourced job
    if (cloudIds.length > 0) {
      import('../../services/cloudSync.js').then(({ updateCloudStatus, isEnabled }) => {
        if (!isEnabled()) return;
        for (const cid of cloudIds) {
          updateCloudStatus(cid, status).catch(err => warnCloudSyncFailed(cloudIds.length, err));
        }
      }).catch(err => warnCloudSyncFailed(cloudIds.length, err));
    }
  });

  // Update payment status for a single job
  app.put("/api/jobs/:id/payment", requireAdmin, (req, res) => {
    const { id } = req.params;
    const { paymentStatus, paymentAmount } = req.body;
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return res.status(404).json({ success: false, error: "Job not found" });
    const paymentDate = paymentStatus === 'PAID' || paymentStatus === 'PARTIAL' ? new Date().toISOString() : null;
    db.prepare('UPDATE jobs SET paymentStatus = ?, paymentAmount = ?, paymentDate = ? WHERE id = ?').run(paymentStatus, paymentAmount || null, paymentDate, id);
    res.status(200).json({ success: true });
  });

  // Bulk payment update
  app.post("/api/jobs/bulk/payment", requireAdmin, (req, res) => {
    const { ids, paymentStatus } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No IDs provided" });
    }
    const paymentDate = paymentStatus === 'PAID' || paymentStatus === 'PARTIAL' ? new Date().toISOString() : null;
    const stmt = db.prepare('UPDATE jobs SET paymentStatus = ?, paymentDate = ? WHERE id = ?');
    const txn = db.transaction((jobIds) => {
      for (const id of jobIds) stmt.run(paymentStatus, paymentDate, id);
    });
    txn(ids);
    res.status(200).json({ success: true, updated: ids.length });
  });
}
