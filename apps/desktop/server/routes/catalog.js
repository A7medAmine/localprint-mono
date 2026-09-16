// The shop's price list: paper types and the discount rules applied to them.
import {
  getPaperTypes,
  createPaperType,
  updatePaperType,
  deletePaperType,
  getDiscountRules,
  getActiveDiscountRules,
  createDiscountRule,
  updateDiscountRule,
  deleteDiscountRule,
} from "../../db.js";
import { requireAdmin } from "../adminAuth.js";
import { triggerCloudSettingsSync } from "../cloudSettings.js";

export function registerCatalogRoutes(app) {
  /**
   * DISCOUNT RULES API
   */

  // Get all discount rules
  app.get("/api/discount-rules", (req, res) => {
    try {
      const rules = getDiscountRules();
      res.status(200).json(rules);
    } catch (err) {
      console.error("❌ Error fetching discount rules:", err);
      res.status(500).json({ error: "Failed to fetch discount rules" });
    }
  });

  // Get active discount rules only
  app.get("/api/discount-rules/active", (req, res) => {
    try {
      const rules = getActiveDiscountRules();
      res.status(200).json(rules);
    } catch (err) {
      console.error("❌ Error fetching active discount rules:", err);
      res.status(500).json({ error: "Failed to fetch discount rules" });
    }
  });

  // Create new discount rule
  app.post("/api/discount-rules", requireAdmin, (req, res) => {
    try {
      const { id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap, priority, is_active } = req.body;

      if (!id || !name || !discount_type || !condition_type || threshold === undefined) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const rule = createDiscountRule({
        id,
        name,
        discount_type,
        discount_value: parseFloat(discount_value) || 0,
        condition_type,
        threshold: parseInt(threshold) || 0,
        max_discount_cap: max_discount_cap ? parseFloat(max_discount_cap) : null,
        priority: parseInt(priority) || 0,
        is_active: is_active !== undefined ? is_active : true,
      });

      res.status(201).json(rule);
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error creating discount rule:", err);
      res.status(500).json({ error: "Failed to create discount rule" });
    }
  });

  // Update discount rule
  app.put("/api/discount-rules/:id", requireAdmin, (req, res) => {
    try {
      const ruleId = req.params.id;
      const updates = req.body;

      // Convert numeric fields
      if (updates.discount_value !== undefined) {
        updates.discount_value = parseFloat(updates.discount_value);
      }
      if (updates.threshold !== undefined) {
        updates.threshold = parseInt(updates.threshold);
      }
      if (updates.max_discount_cap !== undefined) {
        updates.max_discount_cap = updates.max_discount_cap ? parseFloat(updates.max_discount_cap) : null;
      }
      if (updates.priority !== undefined) {
        updates.priority = parseInt(updates.priority);
      }

      const rule = updateDiscountRule(ruleId, updates);
      if (!rule) {
        return res.status(404).json({ error: "Discount rule not found" });
      }

      res.status(200).json(rule);
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error updating discount rule:", err);
      res.status(500).json({ error: "Failed to update discount rule" });
    }
  });

  // Delete discount rule
  app.delete("/api/discount-rules/:id", requireAdmin, (req, res) => {
    try {
      const ruleId = req.params.id;
      deleteDiscountRule(ruleId);
      res.status(200).json({ success: true, id: ruleId });
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error deleting discount rule:", err);
      res.status(500).json({ error: "Failed to delete discount rule" });
    }
  });

  /**
   * PAPER TYPES API
   */

  // Get all paper types
  app.get("/api/paper-types", (req, res) => {
    try {
      res.status(200).json(getPaperTypes());
    } catch (err) {
      console.error("❌ Error fetching paper types:", err);
      res.status(500).json({ error: "Failed to fetch paper types" });
    }
  });

  // Create paper type
  app.post("/api/paper-types", requireAdmin, (req, res) => {
    try {
      const { id, name, nameAr, colorPerPage, blackWhitePerPage } = req.body;
      if (!id || !name) {
        return res.status(400).json({ error: "Missing required fields (id, name)" });
      }
      const pt = createPaperType({ id, name, nameAr: nameAr || '', colorPerPage: parseFloat(colorPerPage) || 0, blackWhitePerPage: parseFloat(blackWhitePerPage) || 0 });
      res.status(201).json(pt);
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error creating paper type:", err);
      res.status(500).json({ error: "Failed to create paper type" });
    }
  });

  // Update paper type
  app.put("/api/paper-types/:id", requireAdmin, (req, res) => {
    try {
      const pt = updatePaperType(req.params.id, req.body);
      if (!pt) return res.status(404).json({ error: "Paper type not found" });
      res.status(200).json(pt);
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error updating paper type:", err);
      res.status(500).json({ error: "Failed to update paper type" });
    }
  });

  // Delete paper type
  app.delete("/api/paper-types/:id", requireAdmin, (req, res) => {
    try {
      deletePaperType(req.params.id);
      res.status(200).json({ success: true });
      triggerCloudSettingsSync();
    } catch (err) {
      console.error("❌ Error deleting paper type:", err);
      res.status(500).json({ error: "Failed to delete paper type" });
    }
  });
}
