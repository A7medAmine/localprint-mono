import React, { useEffect, useState } from "react";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Icon } from "../../../components/ui/icon";
import { Card, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { useAdmin } from "../AdminContext";
import { errorMessage } from "@atba3li/shared";
import { passwordPolicyMessage, translateAuthError } from "../../../lib/passwordPolicy";
import RecoveryCodeDialog from "../../../components/RecoveryCodeDialog";

/** Change the operator password. Self-contained: the form state never leaves
 *  this card, so the settings panel does not carry it. */
export const PasswordCard: React.FC = () => {
  const { isRtl } = useAdmin();
  const [passwordForm, setPasswordForm] = useState({ current: "", newPass: "", confirm: "" });
  const [showPasswords, setShowPasswords] = useState({ current: false, newPass: false, confirm: false });
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);
    // Same rules the server enforces (8+ chars, not all digits) — the old
    // 4-char check let short passwords through to a confusing server refusal.
    const policy = passwordPolicyMessage(passwordForm.newPass, passwordForm.confirm, isRtl);
    if (policy) {
      setPasswordError(policy);
      return;
    }
    try {
      await storageService.changePassword(passwordForm.current, passwordForm.newPass);
      setPasswordSuccess(true);
      setPasswordForm({ current: "", newPass: "", confirm: "" });
      toast({ title: isRtl ? "تم تغيير كلمة المرور بنجاح" : "Password changed successfully", variant: "success" });
    } catch (err) {
      setPasswordError(translateAuthError(errorMessage(err), isRtl));
    }
  };

  // ── Recovery code ──
  const [recovery, setRecovery] = useState<{ hasCode: boolean; createdAt: string | null } | null>(null);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [shownCode, setShownCode] = useState<string | null>(null);

  useEffect(() => {
    storageService
      .getRecoveryCodeStatus()
      .then(setRecovery)
      .catch(() => setRecovery({ hasCode: false, createdAt: null }));
  }, []);

  const handleGenerateRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setRecoveryError("");
    if (!recoveryPassword) {
      setRecoveryError(isRtl ? "أدخل كلمة المرور الحالية" : "Enter your current password");
      return;
    }
    setGenerating(true);
    try {
      const result = await storageService.createRecoveryCode(recoveryPassword);
      setRecovery({ hasCode: result.hasCode, createdAt: result.createdAt });
      setRecoveryPassword("");
      setShownCode(result.code);
    } catch (err) {
      setRecoveryError(translateAuthError(errorMessage(err), isRtl));
    } finally {
      setGenerating(false);
    }
  };

  const recoveryDate = recovery?.createdAt
    ? ` · ${new Date(recovery.createdAt).toLocaleDateString(isRtl ? "ar" : "en")}`
    : "";

  return (
    <Card className="lg:col-span-2 border-0">
      <CardHeader className="flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center flex-shrink-0">
            <Icon name="key" className="w-5 h-5" />
          </div>
          <div>
            <CardTitle className="text-base">{isRtl ? "تغيير كلمة المرور" : "Change Password"}</CardTitle>
            <CardDescription>{isRtl ? "تحديث كلمة مرور المسؤول" : "Update admin password"}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <form onSubmit={handleChangePassword} className="p-5 sm:p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "كلمة المرور الحالية" : "Current Password"}</label>
            <div className="relative">
              <Input type={showPasswords.current ? "text" : "password"} value={passwordForm.current} onChange={(e) => setPasswordForm({ ...passwordForm, current: e.target.value })} placeholder="••••••••" required className="pe-10" />
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, current: !p.current }))} aria-label={isRtl ? "إظهار كلمة المرور" : "Show password"} className="absolute end-1 top-1/2 -translate-y-1/2 h-8 w-8" tabIndex={-1}>
                {showPasswords.current ? <Icon name="eye-off" className="w-4 h-4" /> : <Icon name="eye" className="w-4 h-4" />}
              </Button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "كلمة المرور الجديدة" : "New Password"}</label>
            <div className="relative">
              <Input type={showPasswords.newPass ? "text" : "password"} value={passwordForm.newPass} onChange={(e) => setPasswordForm({ ...passwordForm, newPass: e.target.value })} placeholder="••••••••" required className="pe-10" />
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, newPass: !p.newPass }))} aria-label={isRtl ? "إظهار كلمة المرور الجديدة" : "Show new password"} className="absolute end-1 top-1/2 -translate-y-1/2 h-8 w-8" tabIndex={-1}>
                {showPasswords.newPass ? <Icon name="eye-off" className="w-4 h-4" /> : <Icon name="eye" className="w-4 h-4" />}
              </Button>
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-foreground mb-2">{isRtl ? "تأكيد كلمة المرور" : "Confirm Password"}</label>
            <div className="relative">
              <Input type={showPasswords.confirm ? "text" : "password"} value={passwordForm.confirm} onChange={(e) => setPasswordForm({ ...passwordForm, confirm: e.target.value })} placeholder="••••••••" required className="pe-10" />
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowPasswords(p => ({ ...p, confirm: !p.confirm }))} aria-label={isRtl ? "إظهار تأكيد كلمة المرور" : "Show password confirmation"} className="absolute end-1 top-1/2 -translate-y-1/2 h-8 w-8" tabIndex={-1}>
                {showPasswords.confirm ? <Icon name="eye-off" className="w-4 h-4" /> : <Icon name="eye" className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>
        {passwordError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{passwordError}</p>}
        {passwordSuccess && <p className="text-sm text-green-600 dark:text-green-400 font-medium"><><Icon name="check" className="inline-block me-1 align-text-bottom" />{isRtl ? "تم تغيير كلمة المرور بنجاح" : "Password changed successfully"}</></p>}
        <Button type="submit" variant="destructive">{isRtl ? "تغيير كلمة المرور" : "Change Password"}</Button>
      </form>

      <form onSubmit={handleGenerateRecovery} className="px-5 sm:px-6 pb-6 pt-5 border-t border-border space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{isRtl ? "مفتاح استرداد كلمة المرور" : "Password recovery key"}</h4>
          <p className="text-xs text-muted-foreground mt-1">
            {isRtl
              ? "إذا نسيت كلمة المرور، استخدم هذا المفتاح من شاشة الدخول (نسيت كلمة المرور؟) لتعيين كلمة جديدة. نزّله واحفظه في مكان آمن خارج هذا الجهاز."
              : "If you forget the password, use this key on the login screen (Forgot password?) to set a new one. Download it and keep it somewhere safe, off this computer."}
          </p>
          {recovery && (
            <p className={`text-xs mt-2 font-medium ${recovery.hasCode ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
              {recovery.hasCode
                ? (isRtl ? "مفتاح الاسترداد مُفعّل" : "Recovery key is set") + recoveryDate
                : isRtl
                  ? "لا يوجد مفتاح استرداد — أنشئ واحدًا حتى لا تفقد الوصول."
                  : "No recovery key yet — create one so you never get locked out."}
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <Input
            type="password"
            value={recoveryPassword}
            onChange={(e) => setRecoveryPassword(e.target.value)}
            placeholder={isRtl ? "كلمة المرور الحالية" : "Current password"}
            className="sm:max-w-xs"
            autoComplete="current-password"
          />
          <Button type="submit" variant="outline" disabled={generating} className="gap-2">
            <Icon name="key" className="w-4 h-4" />
            {recovery?.hasCode
              ? (isRtl ? "إنشاء مفتاح جديد" : "Generate new key")
              : (isRtl ? "إنشاء مفتاح استرداد" : "Create recovery key")}
          </Button>
        </div>
        {recovery?.hasCode && (
          <p className="text-xs text-muted-foreground">{isRtl ? "إنشاء مفتاح جديد يُبطل المفتاح القديم." : "Generating a new key invalidates the old one."}</p>
        )}
        {recoveryError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{recoveryError}</p>}
      </form>

      <RecoveryCodeDialog code={shownCode} isRtl={isRtl} onClose={() => setShownCode(null)} />
    </Card>
  );
};
