// Customer CVs built and printed in-shop, saved so they can be reprinted
// later without retyping. Mirrors credentials.js's shape.
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import {
  getCvProfiles,
  getCvProfile,
  createCvProfile,
  updateCvProfile,
  updateCvProfilePhoto,
  deleteCvProfile,
} from "../../db.js";
import { UPLOADS_DIR } from "../config.js";
import { requireAdmin } from "../adminAuth.js";
import { upload } from "../uploads.js";

export function registerCvRoutes(app) {
  app.get("/api/cvs", requireAdmin, (req, res) => {
    try {
      res.status(200).json(getCvProfiles(req.query.search ? String(req.query.search) : undefined));
    } catch (err) {
      console.error("❌ Error fetching CVs:", err);
      res.status(500).json({ error: "Failed to fetch CVs" });
    }
  });

  app.get("/api/cvs/:id", requireAdmin, (req, res) => {
    try {
      const cv = getCvProfile(req.params.id);
      if (!cv) return res.status(404).json({ error: "CV not found" });
      res.status(200).json(cv);
    } catch (err) {
      console.error("❌ Error fetching CV:", err);
      res.status(500).json({ error: "Failed to fetch CV" });
    }
  });

  app.post("/api/cvs", requireAdmin, (req, res) => {
    try {
      const { fullName, phone, data } = req.body;
      if (!fullName || !String(fullName).trim()) {
        return res.status(400).json({ error: "Missing required field (fullName)" });
      }
      const cv = createCvProfile({
        id: `cv_${randomBytes(8).toString("hex")}`,
        fullName: String(fullName).trim(),
        phone: phone ? String(phone).trim() : "",
        data: data && typeof data === "object" ? data : {},
      });
      res.status(201).json(cv);
    } catch (err) {
      console.error("❌ Error creating CV:", err);
      res.status(500).json({ error: "Failed to create CV" });
    }
  });

  app.put("/api/cvs/:id", requireAdmin, (req, res) => {
    try {
      const { fullName, phone, data } = req.body;
      const updates = {};
      if (fullName !== undefined) updates.fullName = String(fullName).trim();
      if (phone !== undefined) updates.phone = String(phone).trim();
      if (data !== undefined && typeof data === "object") updates.data = data;

      const cv = updateCvProfile(req.params.id, updates);
      if (!cv) return res.status(404).json({ error: "CV not found" });
      res.status(200).json(cv);
    } catch (err) {
      console.error("❌ Error updating CV:", err);
      res.status(500).json({ error: "Failed to update CV" });
    }
  });

  app.delete("/api/cvs/:id", requireAdmin, (req, res) => {
    try {
      const cv = getCvProfile(req.params.id);
      if (!cv) return res.status(404).json({ error: "CV not found" });
      if (cv.photoFilename) {
        const oldPath = path.join(UPLOADS_DIR, cv.photoFilename);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch { console.warn("⚠️  Could not delete CV photo"); }
        }
      }
      deleteCvProfile(req.params.id);
      res.status(200).json({ success: true, id: req.params.id });
    } catch (err) {
      console.error("❌ Error deleting CV:", err);
      res.status(500).json({ error: "Failed to delete CV" });
    }
  });

  app.post("/api/cvs/:id/photo", requireAdmin, upload.single("photo"), (req, res) => {
    try {
      const cv = getCvProfile(req.params.id);
      if (!cv) return res.status(404).json({ error: "CV not found" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      if (cv.photoFilename) {
        const oldPath = path.join(UPLOADS_DIR, cv.photoFilename);
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch { console.warn("⚠️  Could not delete old CV photo"); }
        }
      }

      const updated = updateCvProfilePhoto(req.params.id, req.file.filename);
      res.status(200).json(updated);
    } catch (err) {
      console.error("❌ Error uploading CV photo:", err);
      res.status(500).json({ error: "Failed to upload CV photo" });
    }
  });

  app.get("/api/cvs/:id/photo", requireAdmin, (req, res) => {
    const cv = getCvProfile(req.params.id);
    if (!cv?.photoFilename) return res.status(404).json({ error: "No photo" });
    const filePath = path.resolve(path.join(UPLOADS_DIR, cv.photoFilename));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Photo not found" });
    }
    res.sendFile(filePath);
  });
}
