// Serving stored job files, the shop logo, and database backup/restore.
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import db, { getInternalState, reopenDb, checkpointAndClose } from "../../db.js";
import { DB_PATH, UPLOADS_DIR } from "../config.js";
import { requireAdmin } from "../adminAuth.js";
import { uploadMemory } from "../uploads.js";

export function registerFileRoutes(app) {
  // Database backup download
  app.get("/api/backup/download", requireAdmin, (req, res) => {
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ success: false, error: "Database not found" });
    }
    res.download(DB_PATH, `atba3li-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
  });

  // Database backup restore
  app.post("/api/backup/restore", requireAdmin, uploadMemory.single("file"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }
    const _dbPath = DB_PATH;
    const _backupPath = _dbPath + '.before_restore';
    const _incomingPath = _dbPath + '.incoming';

    // 1. Write the upload to a scratch file and prove it's a healthy SQLite
    //    database with our schema BEFORE touching the live file. A truncated
    //    upload or a wrong-file paste used to overwrite the DB unconditionally.
    try {
      fs.writeFileSync(_incomingPath, req.file.buffer);
      const probe = new Database(_incomingPath, { readonly: true, fileMustExist: true });
      try {
        const integrity = probe.pragma('integrity_check', { simple: true });
        if (integrity !== 'ok') throw new Error(`integrity_check failed: ${integrity}`);
        const hasJobs = probe.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'"
        ).get();
        if (!hasJobs) throw new Error("not an Atba3li backup (no 'jobs' table)");
      } finally {
        probe.close();
      }
    } catch (e) {
      try { fs.unlinkSync(_incomingPath); } catch { /* ignored */ }
      return res.status(400).json({ success: false, error: `Invalid backup file — ${e.message}` });
    }

    // 2. Checkpoint the WAL into the live file, close, swap, reopen.
    checkpointAndClose();
    try {
      if (fs.existsSync(_dbPath)) fs.copyFileSync(_dbPath, _backupPath);
      fs.renameSync(_incomingPath, _dbPath);
      // A fresh restore starts from a clean file — stale WAL/SHM from the old
      // database must not be replayed on top of it.
      for (const ext of ['-wal', '-shm']) {
        try { fs.unlinkSync(_dbPath + ext); } catch { /* ignored */ }
      }
      reopenDb();
      res.status(200).json({ success: true });
    } catch (e) {
      try { if (fs.existsSync(_backupPath)) fs.copyFileSync(_backupPath, _dbPath); } catch { /* ignored */ }
      try { reopenDb(); } catch { /* ignored */ }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Public file access by job ID — anyone with the job ID can download (must be before the admin catch-all)
  // Resolve a job to its absolute path on this machine. Admin-only — this
  // leaks the local FS layout, so the renderer only calls it inside the
  // Electron desktop app to feed the native print IPC. Path-traversal
  // protected same way as /api/files/*.
  app.get("/api/files/localpath/:id", requireAdmin, (req, res) => {
    try {
      const job = db.prepare('SELECT serverFileName FROM jobs WHERE id = ?').get(req.params.id);
      if (!job || !job.serverFileName) {
        return res.status(404).json({ error: "File not found" });
      }
      const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
      if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }
      res.json({ path: filePath });
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin preview/download by job id — unlike /api/files/public/:id this does
  // NOT hide jobs awaiting review, because reviewing a job means looking at its
  // file before accepting or rejecting it. Admin token required.
  app.get("/api/files/review/:id", requireAdmin, (req, res) => {
    try {
      const job = db.prepare('SELECT serverFileName, fileName, fileType FROM jobs WHERE id = ?').get(req.params.id);
      if (!job || !job.serverFileName) {
        return res.status(404).json({ error: "File not found" });
      }
      const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
      if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }
      const safeName = (job.fileName || "file").replace(/[^a-zA-Z0-9._-]/g, '_');
      const inline = /^image\//.test(job.fileType || "") || job.fileType === "application/pdf";
      res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`);
      res.sendFile(filePath);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/files/public/:id", (req, res) => {
    try {
      const job = db.prepare('SELECT serverFileName, fileName, fileType, status FROM jobs WHERE id = ?').get(req.params.id);
      if (!job || !job.serverFileName) {
        return res.status(404).json({ error: "File not found" });
      }
      // Don't serve files for jobs that haven't cleared review or were rejected.
      if (["pending_review", "rejected", "REJECTED"].includes(job.status)) {
        return res.status(404).json({ error: "File not available" });
      }
      const filePath = path.resolve(path.join(UPLOADS_DIR, job.serverFileName));
      if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
        return res.status(403).json({ error: "Forbidden" });
      }
      if (fs.existsSync(filePath)) {
        const safeName = (job.fileName || "file").replace(/[^a-zA-Z0-9._-]/g, '_');
        const inline = /^image\//.test(job.fileType || "") || job.fileType === "application/pdf";
        res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${safeName}"`);
        res.sendFile(filePath);
      } else {
        res.status(404).json({ error: "File not found" });
      }
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Download/view file by server file name (admin only — path traversal protected)
  app.get(/^\/api\/files\/(.+)/, requireAdmin, (req, res) => {
    const requested = path.normalize(req.params[0]).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.resolve(path.join(UPLOADS_DIR, requested));

    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (fs.existsSync(filePath)) {
      // Stored uploads are immutable for a given serverFileName — a replaced file
      // gets a new name — so the preview pane can reuse them instead of
      // re-downloading on every open.
      res.sendFile(filePath, { maxAge: "1h", etag: true });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  });

  // Public logo access (no auth — shown on public upload page)
  app.get("/api/logo", (req, res) => {
    const filename = getInternalState('_logo_filename');
    if (!filename) return res.status(404).json({ error: "No logo" });
    const filePath = path.resolve(path.join(UPLOADS_DIR, filename));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Logo not found" });
    }
    res.sendFile(filePath);
  });
}
