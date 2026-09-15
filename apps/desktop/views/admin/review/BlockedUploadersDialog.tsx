import React, { useCallback, useEffect, useState } from "react";
import { BlockedUploader } from "../../../types";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";

type BlockKind = BlockedUploader["kind"];

interface BlockedUploadersDialogProps {
  open: boolean;
  isRtl: boolean;
  onClose: () => void;
  /** Bubbles the current count up so the panel button can show it. */
  onCountChange?: (count: number) => void;
}

const kindLabel = (kind: BlockKind, isRtl: boolean) => {
  switch (kind) {
    case "ip": return "IP";
    case "fingerprint": return isRtl ? "جهاز" : "Device";
    case "phone": return isRtl ? "هاتف" : "Phone";
    case "user": return isRtl ? "حساب" : "Account";
  }
};

/**
 * The shop's upload blocklist: review what is blocked, add an entry by hand,
 * and unblock. The list is the cloud's — every call here is proxied through
 * the desktop server to the shop-token API, so an offline app shows the error
 * rather than a stale local copy.
 */
const BlockedUploadersDialog: React.FC<BlockedUploadersDialogProps> = ({ open, isRtl, onClose, onCountChange }) => {
  const [blocks, setBlocks] = useState<BlockedUploader[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Manual add — for an IP or a phone the operator got from somewhere else.
  // Fingerprints are never typed by hand; they only come from an order.
  const [newKind, setNewKind] = useState<BlockKind>("phone");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await storageService.getBlockedUploaders();
      setBlocks(data);
      onCountChange?.(data.length);
    } catch (err: any) {
      setError(err?.message || (isRtl ? "تعذر تحميل القائمة" : "Could not load the blocklist"));
    } finally {
      setLoading(false);
    }
  }, [isRtl, onCountChange]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleAdd = async () => {
    const value = newValue.trim();
    if (!value) return;
    setAdding(true);
    try {
      await storageService.blockUploader({ kind: newKind, value, reason: "", label: "" });
      setNewValue("");
      toast({ title: isRtl ? "تمت الإضافة" : "Blocked", variant: "success" });
      await load();
    } catch (err: any) {
      toast({ title: isRtl ? "فشل الحظر" : "Block failed", description: err?.message, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (block: BlockedUploader) => {
    setRemovingId(block.id);
    try {
      await storageService.unblockUploader(block.id);
      toast({ title: isRtl ? "تم إلغاء الحظر" : "Unblocked", variant: "success" });
      await load();
    } catch (err: any) {
      toast({ title: isRtl ? "فشل إلغاء الحظر" : "Unblock failed", description: err?.message, variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isRtl ? "المرسلون المحظورون" : "Blocked uploaders"}</DialogTitle>
          <DialogDescription>
            {isRtl
              ? "هؤلاء لا يستطيعون رفع طلبات جديدة إلى متجرك عبر الرابط الإلكتروني."
              : "These senders cannot upload new orders to your store through the online link."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2">
          <div className="w-32 shrink-0">
            <label className="block text-xs font-semibold text-muted-foreground mb-1">
              {isRtl ? "النوع" : "Type"}
            </label>
            <Select value={newKind} onValueChange={(v) => setNewKind(v as BlockKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="phone">{kindLabel("phone", isRtl)}</SelectItem>
                <SelectItem value="ip">{kindLabel("ip", isRtl)}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-0">
            <label className="block text-xs font-semibold text-muted-foreground mb-1">
              {newKind === "phone" ? (isRtl ? "رقم الهاتف" : "Phone number") : (isRtl ? "عنوان IP" : "IP address")}
            </label>
            <Input
              value={newValue}
              dir="ltr"
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder={newKind === "phone" ? "0555000000" : "197.0.0.1"}
            />
          </div>
          <Button onClick={handleAdd} disabled={adding || !newValue.trim()}>
            {isRtl ? "حظر" : "Block"}
          </Button>
        </div>

        <div className="max-h-72 overflow-y-auto -mx-1 px-1">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isRtl ? "جارٍ التحميل..." : "Loading..."}
            </p>
          ) : error ? (
            <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : blocks.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isRtl ? "لا يوجد أحد محظور." : "Nobody is blocked."}
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {blocks.map((block) => (
                <li key={block.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {kindLabel(block.kind, isRtl)}
                      </span>
                      <span className="text-sm font-medium text-foreground truncate" dir="ltr">
                        {/* A fingerprint is a 64-char hash — show a readable stub. */}
                        {block.kind === "fingerprint" ? `${block.value.slice(0, 12)}…` : block.value}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {[block.label, block.reason].filter(Boolean).join(" — ") ||
                        new Date(block.createdAt).toLocaleDateString(isRtl ? "ar-EG" : "en-US", { numberingSystem: "latn" })}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removingId === block.id}
                    onClick={() => handleRemove(block)}
                    className="shrink-0"
                  >
                    {isRtl ? "إلغاء الحظر" : "Unblock"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BlockedUploadersDialog;
