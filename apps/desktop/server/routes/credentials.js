// Customer account credentials: saved for later, printed on a card.
import { randomBytes } from "crypto";
import {
  getCredentials,
  getCredential,
  createCredential,
  updateCredential,
  deleteCredential,
  getCredentialSettings,
  updateCredentialSettings,
} from "../../db.js";
import { requireAdmin } from "../adminAuth.js";

export function registerCredentialRoutes(app) {
  // Shop-wide service presets + default notice. Registered before "/:id" so
  // the literal path "settings" isn't swallowed by the param route.
  app.get("/api/credentials/settings", requireAdmin, (req, res) => {
    try {
      res.status(200).json(getCredentialSettings());
    } catch (err) {
      console.error("❌ Error fetching credential settings:", err);
      res.status(500).json({ error: "Failed to fetch credential settings" });
    }
  });

  app.put("/api/credentials/settings", requireAdmin, (req, res) => {
    try {
      const { services, defaultNotice, fontScale } = req.body;
      if (services !== undefined && !Array.isArray(services)) {
        return res.status(400).json({ error: "services must be an array" });
      }
      const cleanServices = Array.isArray(services)
        ? services
            .map((s) => ({
              id: String(s.id || "").trim(),
              name: String(s.name || "").trim(),
              websiteUrl: String(s.websiteUrl || "").trim(),
            }))
            .filter((s) => s.name)
        : undefined;
      const settings = updateCredentialSettings({
        services: cleanServices,
        defaultNotice: defaultNotice !== undefined ? String(defaultNotice).trim() : undefined,
        fontScale,
      });
      res.status(200).json(settings);
    } catch (err) {
      console.error("❌ Error updating credential settings:", err);
      res.status(500).json({ error: "Failed to update credential settings" });
    }
  });

  // Masked list — passwords never leave the machine as plaintext here.
  app.get("/api/credentials", requireAdmin, (req, res) => {
    try {
      res.status(200).json(getCredentials());
    } catch (err) {
      console.error("❌ Error fetching credentials:", err);
      res.status(500).json({ error: "Failed to fetch credentials" });
    }
  });

  // Single record, decrypted — only called right before edit or print.
  app.get("/api/credentials/:id", requireAdmin, (req, res) => {
    try {
      const cred = getCredential(req.params.id);
      if (!cred) return res.status(404).json({ error: "Credential not found" });
      res.status(200).json(cred);
    } catch (err) {
      console.error("❌ Error fetching credential:", err);
      res.status(500).json({ error: "Failed to fetch credential" });
    }
  });

  app.post("/api/credentials", requireAdmin, (req, res) => {
    try {
      const { customerName, serviceName, websiteUrl, username, password, notice } = req.body;
      if (!customerName || !String(customerName).trim()) {
        return res.status(400).json({ error: "Missing required field (customerName)" });
      }
      if (!serviceName || !String(serviceName).trim()) {
        return res.status(400).json({ error: "Missing required field (serviceName)" });
      }
      if (!username || !String(username).trim()) {
        return res.status(400).json({ error: "Missing required field (username)" });
      }
      if (!password) {
        return res.status(400).json({ error: "Missing required field (password)" });
      }

      const cred = createCredential({
        id: `cred_${randomBytes(8).toString("hex")}`,
        customerName: String(customerName).trim(),
        serviceName: String(serviceName).trim(),
        websiteUrl: websiteUrl ? String(websiteUrl).trim() : "",
        username: String(username).trim(),
        password: String(password),
        notice: notice ? String(notice).trim() : "",
      });
      res.status(201).json(cred);
    } catch (err) {
      console.error("❌ Error creating credential:", err);
      res.status(500).json({ error: "Failed to create credential" });
    }
  });

  app.put("/api/credentials/:id", requireAdmin, (req, res) => {
    try {
      const { customerName, serviceName, websiteUrl, username, password, notice } = req.body;

      const updates = {};
      if (customerName !== undefined) updates.customerName = String(customerName).trim();
      if (serviceName !== undefined) updates.serviceName = String(serviceName).trim();
      if (websiteUrl !== undefined) updates.websiteUrl = String(websiteUrl).trim();
      if (username !== undefined) updates.username = String(username).trim();
      if (password) updates.password = String(password);
      if (notice !== undefined) updates.notice = String(notice).trim();

      const cred = updateCredential(req.params.id, updates);
      if (!cred) return res.status(404).json({ error: "Credential not found" });
      res.status(200).json(cred);
    } catch (err) {
      console.error("❌ Error updating credential:", err);
      res.status(500).json({ error: "Failed to update credential" });
    }
  });

  app.delete("/api/credentials/:id", requireAdmin, (req, res) => {
    try {
      if (!getCredential(req.params.id)) {
        return res.status(404).json({ error: "Credential not found" });
      }
      deleteCredential(req.params.id);
      res.status(200).json({ success: true, id: req.params.id });
    } catch (err) {
      console.error("❌ Error deleting credential:", err);
      res.status(500).json({ error: "Failed to delete credential" });
    }
  });
}
