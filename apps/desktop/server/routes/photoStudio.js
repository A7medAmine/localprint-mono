// Print Studio's Photos tool: download-on-selection for the image-search
// results shown there. Search itself is served by the research tool's
// generic /api/research/images/search (SearXNG-backed, not paper-specific) —
// only the download+serve step needs its own route here, since the research
// tool's save route (/api/research/:id/images) is tied to a research paper.
import fs from "fs";
import path from "path";
import { requireAdmin } from "../adminAuth.js";
import { UPLOADS_DIR } from "../config.js";
import { saveResearchImages } from "../research/imageFetch.js";

export function registerPhotoStudioRoutes(app) {
  // Downloads each candidate (per-image failure isolation), stores it under
  // UPLOADS_DIR and returns { images, failures } — no DB persistence, this is
  // stateless: the renderer immediately fetches the bytes and turns them into
  // BatchItems.
  app.post("/api/print-studio/images/fetch", requireAdmin, async (req, res) => {
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    if (candidates.length === 0) {
      return res.status(400).json({ error: "candidates must be a non-empty array" });
    }
    try {
      const { images, failures } = await saveResearchImages(candidates);
      res.status(200).json({ images, failures });
    } catch (err) {
      console.error("❌ Error fetching print studio images:", err);
      res.status(500).json({ error: err.message || "Failed to fetch images" });
    }
  });

  // Serves a downloaded image's bytes by its stored filename.
  app.get("/api/print-studio/images/file/:filename", requireAdmin, (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.resolve(path.join(UPLOADS_DIR, filename));
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Image file not found" });
    }
    res.sendFile(filePath);
  });
}
