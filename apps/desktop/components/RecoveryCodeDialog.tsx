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

/** Shows a freshly minted recovery code exactly once. The server keeps only
 *  its hash, so closing this without saving it means generating a new one. */
const RecoveryCodeDialog: React.FC<RecoveryCodeDialogProps> = ({ code, isRtl, onClose }) => {
  const tr = (ar: string, en: string) => (isRtl ? ar : en);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is on screen to copy by hand */
    }
  };

  const download = () => {
    if (!code) return;
    const text = [
      "Atba3li — admin recovery code / رمز استرداد كلمة المرور",
      "",
      code,
      "",
      "Use it on the login screen: Forgot password? → Recovery code.",
      "One use only. A new code is issued after you use it.",
      "استخدمه في شاشة الدخول: نسيت كلمة المرور؟ ← رمز الاسترداد. صالح لمرة واحدة.",
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "atba3li-recovery-code.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const close = () => {
    setSaved(false);
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={!!code} onOpenChange={(open) => { if (!open && saved) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("رمز استرداد كلمة المرور", "Password recovery code")}</DialogTitle>
          <DialogDescription>
            {tr(
              "إذا نسيت كلمة المرور، يتيح لك هذا الرمز تعيين كلمة جديدة من شاشة الدخول. احفظه في مكان آمن بعيدًا عن هذا الجهاز — لن يُعرض مرة أخرى.",
              "If you forget the password, this code lets you set a new one from the login screen. Keep it somewhere safe, away from this computer — it won't be shown again.",
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
          <Button type="button" variant="outline" onClick={copy} className="gap-2">
            <Icon name={copied ? "check" : "copy"} className="w-4 h-4" />
            {copied ? tr("تم النسخ", "Copied") : tr("نسخ", "Copy")}
          </Button>
          <Button type="button" variant="outline" onClick={download} className="gap-2">
            <Icon name="download" className="w-4 h-4" />
            {tr("تنزيل كملف", "Download as file")}
          </Button>
        </div>

        <label className="flex items-center gap-2 mt-3 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
          {tr("حفظت الرمز في مكان آمن", "I have saved this code somewhere safe")}
        </label>

        <DialogFooter>
          <Button onClick={close} disabled={!saved}>
            {tr("تم", "Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RecoveryCodeDialog;
