import React, { useState, useEffect } from "react";
import QRCode from "qrcode";
import { Language, ShopSettings } from "../types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";

interface ShareQrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: Language;
  shopSlug: string;
  shopSettings?: ShopSettings | null;
}

/**
 * Customer-facing share sheet: a QR code for this shop's public upload page
 * plus a copy/share action. Carries the current language so a scanned link
 * opens in the same language the sharer was using.
 */
const buildShareUrl = (shopSlug: string, lang: Language) =>
  `${window.location.origin}/${shopSlug}?ref=upload&lang=${lang}`;

const ShareQrDialog: React.FC<ShareQrDialogProps> = ({
  open,
  onOpenChange,
  lang,
  shopSlug,
  shopSettings,
}) => {
  const isRtl = lang === "ar";
  const shareUrl = buildShareUrl(shopSlug, lang);

  const [qrPng, setQrPng] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const png = await QRCode.toDataURL(shareUrl, {
          width: 1024,
          margin: 1,
          errorCorrectionLevel: "H",
          color: { dark: "#0f172a", light: "#ffffff" },
        });
        if (!cancelled) setQrPng(png);
      } catch {
        if (!cancelled) setError(isRtl ? "فشل إنشاء رمز QR" : "Failed to generate QR");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, shareUrl, isRtl]);

  const downloadPng = () => {
    if (!qrPng) return;
    const a = document.createElement("a");
    a.download = `qrcode-${shopSlug}-${Date.now()}.png`;
    a.href = qrPng;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const shareLink = async () => {
    const title = shopSettings?.shopName || document.title;
    if (navigator.share) {
      try {
        await navigator.share({ title, url: shareUrl });
        return;
      } catch {
        // Sheet dismissed or sharing unavailable — fall back to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(isRtl ? "تعذّر نسخ الرابط" : "Could not copy the link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isRtl ? "شارك موقع المتجر" : "Share our website"}</DialogTitle>
          <DialogDescription>
            {isRtl
              ? "امسح الرمز بكاميرا هاتفك أو انسخ الرابط لمشاركته مع أصدقائك"
              : "Scan with your phone camera, or copy the link to share it"}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-white dark:bg-slate-50 p-4 flex flex-col items-center gap-3">
          {qrPng ? (
            <img src={qrPng} alt="QR" className="w-48 h-48 rounded-md border border-slate-200" />
          ) : (
            <div className="w-48 h-48 rounded-md border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-400">
              {loading ? (isRtl ? "جارِ التوليد…" : "Generating…") : "—"}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-col sm:flex-row gap-2">
          <Button onClick={shareLink} className="flex-1">
            {copied
              ? isRtl
                ? "تم نسخ الرابط"
                : "Link copied"
              : isRtl
                ? "نسخ / مشاركة الرابط"
                : "Copy / share link"}
          </Button>
          <Button onClick={downloadPng} variant="outline" disabled={loading || !qrPng} className="flex-1">
            {isRtl ? "تحميل رمز QR (PNG)" : "Download QR (PNG)"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground break-all">
          <span className="font-medium">{isRtl ? "الرابط:" : "Link:"}</span> {shareUrl}
        </p>
      </DialogContent>
    </Dialog>
  );
};

export default ShareQrDialog;
