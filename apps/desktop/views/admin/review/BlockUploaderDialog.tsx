import React, { useEffect, useMemo, useState } from "react";
import { PrintJob } from "../../../types";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";

type BlockKind = "ip" | "fingerprint" | "phone" | "user";

interface BlockUploaderDialogProps {
  /** The order whose sender is being blocked; null keeps the dialog closed. */
  job: PrintJob | null;
  isRtl: boolean;
  onClose: () => void;
  /** Called after at least one identifier was blocked. */
  onBlocked?: () => void;
}

interface Candidate {
  kind: BlockKind;
  value: string;
  title: string;
  hint: string;
}

/**
 * Block the sender of one order.
 *
 * An order carries up to three usable identifiers — phone, device fingerprint
 * and IP — and the operator picks which ones to block rather than getting all
 * of them silently. That matters: an IP block on a shared connection (a campus,
 * a print shop's own wifi, mobile NAT) takes out every other customer behind
 * it, so it is offered but never pre-selected.
 */
const BlockUploaderDialog: React.FC<BlockUploaderDialogProps> = ({ job, isRtl, onClose, onBlocked }) => {
  const [selected, setSelected] = useState<Set<BlockKind>>(new Set());
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const candidates = useMemo<Candidate[]>(() => {
    if (!job) return [];
    const out: Candidate[] = [];
    const phone = job.phoneNumber?.trim();
    if (phone) {
      out.push({
        kind: "phone",
        value: phone,
        title: isRtl ? "رقم الهاتف" : "Phone number",
        hint: isRtl
          ? "يمنع أي طلب بنفس الرقم. يسهل تغييره."
          : "Stops any order using this number. Easy for them to change.",
      });
    }
    if (job.uploaderFingerprint) {
      out.push({
        kind: "fingerprint",
        value: job.uploaderFingerprint,
        title: isRtl ? "الجهاز" : "Device",
        hint: isRtl
          ? "يمنع نفس المتصفح حتى لو تغيّر الاتصال. يُلغى بمسح بيانات الموقع."
          : "Stops this browser even on a new connection. Cleared by wiping site data.",
      });
    }
    if (job.uploaderIp) {
      out.push({
        kind: "ip",
        value: job.uploaderIp,
        title: isRtl ? "عنوان IP" : "IP address",
        hint: isRtl
          ? "قد يمنع زبائن آخرين على نفس الاتصال (واي فاي مشترك، شبكة الهاتف)."
          : "May also block other customers on the same connection (shared wifi, mobile networks).",
      });
    }
    return out;
  }, [job, isRtl]);

  // Default to the strongest identifier that hurts no one else: the device.
  // The IP stays opt-in for the collateral reason above.
  useEffect(() => {
    if (!job) return;
    const preferred = candidates.find((c) => c.kind === "fingerprint") || candidates.find((c) => c.kind === "phone");
    setSelected(new Set(preferred ? [preferred.kind] : []));
    setReason("");
  }, [job, candidates]);

  const toggle = (kind: BlockKind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!job || selected.size === 0) return;
    const label = job.customerName?.trim() || job.phoneNumber?.trim() || job.fileName;
    setSubmitting(true);
    let blocked = 0;
    const failed: string[] = [];
    try {
      for (const candidate of candidates) {
        if (!selected.has(candidate.kind)) continue;
        try {
          await storageService.blockUploader({
            kind: candidate.kind,
            value: candidate.value,
            reason: reason.trim(),
            label,
          });
          blocked++;
        } catch {
          failed.push(candidate.title);
        }
      }
      if (blocked > 0 && failed.length === 0) {
        toast({ title: isRtl ? "تم حظر المرسل" : "Uploader blocked", variant: "success" });
        onBlocked?.();
        onClose();
      } else if (blocked > 0) {
        toast({
          title: isRtl ? "تم الحظر جزئياً" : "Partially blocked",
          description: failed.join(", "),
          variant: "destructive",
        });
        onBlocked?.();
      } else {
        toast({
          title: isRtl ? "فشل الحظر" : "Block failed",
          description: failed.join(", "),
          variant: "destructive",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={job !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRtl ? "حظر المرسل" : "Block uploader"}</DialogTitle>
          <DialogDescription>
            {isRtl
              ? "لن يتمكن هذا المرسل من رفع طلبات جديدة إلى متجرك. الطلبات الحالية تبقى كما هي."
              : "This sender will not be able to upload new orders to your store. Existing orders are untouched."}
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isRtl
              ? "لا توجد بيانات كافية لحظر هذا الطلب (طلب محلي أو بدون رقم هاتف)."
              : "Nothing to block on this order — it has no phone number and did not come from the online link."}
          </p>
        ) : (
          <div className="space-y-3">
            {candidates.map((candidate) => (
              <label
                key={candidate.kind}
                className="flex items-start gap-3 p-3 rounded-lg border border-border cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 w-4 h-4 accent-red-600"
                  checked={selected.has(candidate.kind)}
                  onChange={() => toggle(candidate.kind)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    {candidate.title}
                    {candidate.kind !== "fingerprint" && (
                      <span className="ms-2 font-normal text-muted-foreground" dir="ltr">
                        {candidate.value}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5">{candidate.hint}</span>
                </span>
              </label>
            ))}
            <div>
              <label className="block text-sm font-semibold text-foreground mb-2">
                {isRtl ? "السبب (اختياري)" : "Reason (optional)"}
              </label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={isRtl ? "لماذا تحظر هذا المرسل؟" : "Why are you blocking this sender?"}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {isRtl ? "إلغاء" : "Cancel"}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {submitting ? (isRtl ? "جارٍ الحظر..." : "Blocking...") : (isRtl ? "حظر" : "Block")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BlockUploaderDialog;
