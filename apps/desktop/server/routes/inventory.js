// Paper stock: items, manual adjustments and the adjustment history.
import { randomBytes } from "crypto";
import {
  INVENTORY_CATEGORIES,
  getLowStockCount,
  getInventoryItems,
  getInventoryItem,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  adjustInventoryStock,
  getInventoryAdjustments,
} from "../../db.js";
import { requireAdmin } from "../adminAuth.js";

export function registerInventoryRoutes(app) {
  /**
   * INVENTORY API
   */

  // Get all inventory items (plus the low-stock count the sidebar badge reads)
  app.get("/api/inventory", requireAdmin, (req, res) => {
    try {
      res.status(200).json({ items: getInventoryItems(), lowStockCount: getLowStockCount() });
    } catch (err) {
      console.error("❌ Error fetching inventory:", err);
      res.status(500).json({ error: "Failed to fetch inventory" });
    }
  });

  // Get the adjustment log — all items, or one item when ?itemId= is supplied
  app.get("/api/inventory/adjustments", requireAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      res.status(200).json(getInventoryAdjustments(req.query.itemId || null, limit));
    } catch (err) {
      console.error("❌ Error fetching inventory adjustments:", err);
      res.status(500).json({ error: "Failed to fetch adjustments" });
    }
  });

  // Create inventory item
  app.post("/api/inventory", requireAdmin, (req, res) => {
    try {
      const { name, category, unit, currentStock, lowStockThreshold, paperTypeId } = req.body;
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "Missing required field (name)" });
      }
      if (!INVENTORY_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${INVENTORY_CATEGORIES.join(', ')}` });
      }

      const item = createInventoryItem({
        id: `inv_${randomBytes(8).toString("hex")}`,
        name: String(name).trim(),
        category,
        unit: unit ? String(unit).trim() : 'units',
        currentStock: Math.max(0, parseFloat(currentStock) || 0),
        lowStockThreshold: Math.max(0, parseFloat(lowStockThreshold) || 0),
        paperTypeId: paperTypeId || null,
      });
      res.status(201).json(item);
    } catch (err) {
      console.error("❌ Error creating inventory item:", err);
      res.status(500).json({ error: "Failed to create inventory item" });
    }
  });

  // Update inventory item
  app.put("/api/inventory/:id", requireAdmin, (req, res) => {
    try {
      const { name, category, unit, currentStock, lowStockThreshold, paperTypeId } = req.body;
      if (category !== undefined && !INVENTORY_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${INVENTORY_CATEGORIES.join(', ')}` });
      }

      const updates = {};
      if (name !== undefined) updates.name = String(name).trim();
      if (category !== undefined) updates.category = category;
      if (unit !== undefined) updates.unit = String(unit).trim() || 'units';
      if (currentStock !== undefined) updates.currentStock = Math.max(0, parseFloat(currentStock) || 0);
      if (lowStockThreshold !== undefined) updates.lowStockThreshold = Math.max(0, parseFloat(lowStockThreshold) || 0);
      if (paperTypeId !== undefined) updates.paperTypeId = paperTypeId || null;

      const item = updateInventoryItem(req.params.id, updates);
      if (!item) return res.status(404).json({ error: "Inventory item not found" });
      res.status(200).json(item);
    } catch (err) {
      console.error("❌ Error updating inventory item:", err);
      res.status(500).json({ error: "Failed to update inventory item" });
    }
  });

  // Delete inventory item
  app.delete("/api/inventory/:id", requireAdmin, (req, res) => {
    try {
      if (!getInventoryItem(req.params.id)) {
        return res.status(404).json({ error: "Inventory item not found" });
      }
      deleteInventoryItem(req.params.id);
      res.status(200).json({ success: true, id: req.params.id });
    } catch (err) {
      console.error("❌ Error deleting inventory item:", err);
      res.status(500).json({ error: "Failed to delete inventory item" });
    }
  });

  // Adjust stock. Manual edits and restocks both land here; 'auto_deduct' is
  // reserved for the printed-job hook below and is rejected from the API.
  app.post("/api/inventory/:id/adjust", requireAdmin, (req, res) => {
    try {
      const { amount, reason, note } = req.body;
      const parsedAmount = parseFloat(amount);
      if (!isFinite(parsedAmount) || parsedAmount === 0) {
        return res.status(400).json({ error: "amount must be a non-zero number" });
      }
      if (reason !== 'manual' && reason !== 'restock') {
        return res.status(400).json({ error: "reason must be 'manual' or 'restock'" });
      }

      const result = adjustInventoryStock(req.params.id, {
        amount: parsedAmount,
        reason,
        note: note ? String(note).trim() : '',
      });
      if (!result) return res.status(404).json({ error: "Inventory item not found" });
      res.status(200).json(result);
    } catch (err) {
      console.error("❌ Error adjusting inventory:", err);
      res.status(500).json({ error: "Failed to adjust inventory" });
    }
  });
}
