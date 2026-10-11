import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

interface RecoveryCodeDialogProps {
  code: string | null;
  isRtl: boolean;
  onClose: () => void;
}

/** Shows a freshly minted recovery key exactly once and makes the operator
 *  download (or copy) it before going on. The server keeps only its hash, so
 *  a key that wasn't saved means generating a new one. */
const RecoveryCodeDialog: React.FC<RecoveryCodeDialogProps> = ({ code, isRtl, onClose }) => {
  const tr = (ar: string, en: string) => (isRtl ? ar : en);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [copiedOnce, setCopiedOnce] = useState(false);
  const kept = downloaded || copiedOnce;

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopiedOnce(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is on screen to copy by hand */
    }
  };

  const download = () => {
    if (!code) return;
    const text = [
      "Atba3li — admin recovery key / مفتاح استرداد كلمة المرور",
      "",
      code,
      "",
      "If you forget the password: login screen → Forgot password? → enter this key.",
      "One use only. A new key is shown after you use it — save that one too.",
      "إذا نسيت كلمة المرور: شاشة الدخول ← نسيت كلمة المرور؟ ← أدخل هذا المفتاح.",
      "صالح لمرة واحدة. يظهر مفتاح جديد بعد استخدامه — احفظه أيضًا.",
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "atba3li-recovery-key.txt";
    a.click();
    setDownloaded(true);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const close = () => {
    setSaved(false);
    setCopied(false);
    setDownloaded(false);
    setCopiedOnce(false);
    onClose();
  };

  return (
    <Dialog open={!!code} onOpenChange={(open) => { if (!open && saved) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("احفظ مفتاح الاسترداد", "Save your recovery key")}</DialogTitle>
          <DialogDescription>
            {tr(
              "هذا المفتاح هو الطريقة الوحيدة لاستعادة الدخول إذا نسيت كلمة المرور. نزّله واحفظه في مكان آمن (هاتفك، فلاشة، أو ورقة) — لن يُعرض مرة أخرى.",
              "This key is the only way back in if you forget the password. Download it and keep it somewhere safe (your phone, a USB stick, or on paper) — it won't be shown again.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div
          dir="ltr"
          className="my-2 rounded-xl border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 px-4 py-5 text-center font-mono text-2xl font-bold tracking-widest text-indigo-700 dark:text-indigo-300 select-all"
        >
          {code}
        </div>

        <div className="flex flex-wrap gap-2 justify-center">
          <Button type="button" onClick={download} className="gap-2">
            <Icon name={downloaded ? "check" : "download"} className="w-4 h-4" />
            {downloaded ? tr("تم التنزيل", "Downloaded") : tr("تنزيل المفتاح", "Download key")}
          </Button>
          <Button type="button" variant="outline" onClick={copy} className="gap-2">
            <Icon name={copied ? "check" : "copy"} className="w-4 h-4" />
            {copied ? tr("تم النسخ", "Copied") : tr("نسخ", "Copy")}
          </Button>
        </div>

        {!kept && (
          <p className="text-xs text-center text-amber-700 dark:text-amber-400 mt-2">
            {tr("نزّل المفتاح أو انسخه للمتابعة.", "Download or copy the key to continue.")}
          </p>
        )}
        <label className={`flex items-center gap-2 mt-3 text-sm text-foreground ${kept ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
          <input type="checkbox" checked={saved} disabled={!kept} onChange={(e) => setSaved(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
          {tr("حفظت المفتاح في مكان آمن", "I have saved this key somewhere safe")}
        </label>

        <DialogFooter>
          <Button onClick={close} disabled={!saved || !kept}>
            {tr("تم", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RecoveryCodeDialog;
