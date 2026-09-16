// Stock that moves without anyone touching the inventory screen.
import {
  getSettings,
  getInventoryItemsByPaperType,
  hasAutoDeductForJob,
  adjustInventoryStock,
} from "../db.js";

/**
 * Deduct paper stock when a job reaches the printed state.
 *
 * Only fires on an actual transition into PRINTED (re-marking an already-printed
 * job must not deduct twice) and only when the shop has opted in via
 * autoDeductStock. If no inventory item is linked to the job's paper type this
 * does nothing — that's a normal state, not an error.
 *
 * Inventory problems must never fail the status update the customer is waiting
 * on, so everything here is best-effort and logged.
 */
export function applyAutoDeductForJob(job, previousStatus) {
  try {
    if (!job || job.status !== 'PRINTED' || previousStatus === 'PRINTED') return;
    if (getSettings().autoDeductStock !== true) return;

    const items = getInventoryItemsByPaperType(job.paperType);
    if (items.length === 0) return;

    const sheets = (job.pageCount || 1) * (job.copies || 1);
    if (sheets <= 0) return;

    for (const item of items) {
      // Idempotency: never auto-deduct the same job/item twice (status toggles).
      if (hasAutoDeductForJob(job.id, item.id)) continue;
      adjustInventoryStock(item.id, {
        amount: -sheets,
        reason: 'auto_deduct',
        note: job.fileName || '',
        jobId: job.id,
      });
      console.log(`📉 Auto-deducted ${sheets} ${item.unit} from "${item.name}" for job ${job.id}`);
    }
  } catch (err) {
    console.error("❌ Auto-deduct error:", err.message);
  }
}
