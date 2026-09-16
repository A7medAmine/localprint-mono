import React, { useState } from "react";
import { storageService } from "../../../services/storageService";
import { toast } from "../../../components/ui/use-toast";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Icon } from "../../../components/ui/icon";
import { Card, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { useAdmin } from "../AdminContext";

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
    if (passwordForm.newPass !== passwordForm.confirm) {
      setPasswordError(isRtl ? "كلمات المرور الجديدة غير متطابقة" : "New passwords do not match");
      return;
    }
    if (passwordForm.newPass.length < 4) {
      setPasswordError(isRtl ? "يجب أن تكون كلمة المرور 4 أحرف على الأقل" : "Password must be at least 4 characters");
      return;
    }
    try {
      await storageService.changePassword(passwordForm.current, passwordForm.newPass);
      setPasswordSuccess(true);
      setPasswordForm({ current: "", newPass: "", confirm: "" });
      toast({ title: isRtl ? "تم تغيير كلمة المرور بنجاح" : "Password changed successfully", variant: "success" });
    } catch {
      setPasswordError(isRtl ? "كلمة المرور الحالية غير صحيحة" : "Current password is incorrect");
    }
  };

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
    </Card>
  );
};
