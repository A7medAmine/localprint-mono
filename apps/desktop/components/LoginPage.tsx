import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Language } from "../types";
import { TRANSLATIONS } from "../constants";
import { storageService } from "../services/storageService";
import { Icon } from "./ui/icon";
import { writePref } from "@atba3li/shared/lib/prefs";
import { errorMessage } from "@atba3li/shared";
import { passwordPolicyMessage, translateAuthError } from "../lib/passwordPolicy";
import RecoveryCodeDialog from "./RecoveryCodeDialog";

interface LoginPageProps {
  lang: Language;
  onLoginSuccess: (token: string) => void;
}

type Mode = "login" | "forgot";

const inputClass =
  "w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500";

const primaryButtonClass =
  "w-full bg-gray-900 dark:bg-indigo-600 text-white font-bold py-2 rounded-lg hover:bg-black dark:hover:bg-indigo-700 transition disabled:opacity-60 disabled:cursor-not-allowed";

const LoginPage: React.FC<LoginPageProps> = ({ lang, onLoginSuccess }) => {
  const navigate = useNavigate();
  const isRtl = lang === "ar";
  const tr = (ar: string, en: string) => (isRtl ? ar : en);

  const [mode, setMode] = useState<Mode>("login");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Forgot-password state
  const [hasRecoveryKey, setHasRecoveryKey] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetError, setResetError] = useState("");

  // A freshly issued key is shown before entering the app; the sign-in waits
  // until the operator confirms they saved it.
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  const finishLogin = (token: string, mustChangePassword = false) => {
    storageService.setAuthToken(token);
    writePref("adminToken", token);
    onLoginSuccess(token);
    // A default/temporary password sends the operator through the first-run
    // wizard (which forces a password change) before the dashboard.
    navigate(mustChangePassword ? "/admin/setup" : "/admin/dashboard", { replace: true });
  };

  const showKeyThenLogin = (token: string, key: string) => {
    setPendingToken(token);
    setNewRecoveryCode(key);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setLoginError("");
    const result = await storageService.verifyPassword(password);
    if (!result.success || !result.token) {
      setSubmitting(false);
      setLoginError(result.error ? translateAuthError(result.error, isRtl) : tr("كلمة المرور خاطئة", "Incorrect password"));
      return;
    }
    // An install without a recovery key (set up before keys existed) gets one
    // now, while we still hold the password that authorises it. The default
    // password goes through the setup wizard instead, which hands one out.
    if (!result.mustChangePassword) {
      try {
        storageService.setAuthToken(result.token);
        const status = await storageService.getRecoveryCodeStatus();
        if (!status.hasCode) {
          const { code: key } = await storageService.createRecoveryCode(password);
          setSubmitting(false);
          showKeyThenLogin(result.token, key);
          return;
        }
      } catch {
        /* best effort — Settings → Password can still make one */
      }
    }
    setSubmitting(false);
    finishLogin(result.token, result.mustChangePassword);
  };

  const openForgot = async () => {
    setMode("forgot");
    setResetError("");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setHasRecoveryKey(null);
    const opts = await storageService.getRecoveryOptions();
    setHasRecoveryKey(opts.recoveryCode);
  };

  const backToLogin = () => {
    setMode("login");
    setResetError("");
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setResetError("");
    if (!code.trim()) {
      setResetError(tr("أدخل مفتاح الاسترداد.", "Enter your recovery key."));
      return;
    }
    const policy = passwordPolicyMessage(newPassword, confirmPassword, isRtl);
    if (policy) {
      setResetError(policy);
      return;
    }
    setSubmitting(true);
    try {
      const result = await storageService.resetForgottenPassword(code, newPassword);
      // The old key is spent; hand out the replacement before entering the app.
      showKeyThenLogin(result.token, result.newRecoveryCode);
    } catch (err) {
      setResetError(translateAuthError(errorMessage(err), isRtl));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-16 px-4">
      <div className="bg-card p-8 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-border">
        {mode === "login" ? (
          <>
            <h2 className="text-2xl font-bold mb-6 text-center text-foreground">{TRANSLATIONS.adminLogin[lang]}</h2>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{TRANSLATIONS.password[lang]}</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    autoFocus
                    className={`${inputClass} pe-10`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={tr("إظهار كلمة المرور", "Show password")}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition"
                    tabIndex={-1}
                  >
                    <Icon name={showPassword ? "eye-off" : "eye"} className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {loginError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{loginError}</p>}
              <button type="submit" className={primaryButtonClass} disabled={submitting || !password}>
                {TRANSLATIONS.loginBtn[lang]}
              </button>
              <button
                type="button"
                onClick={openForgot}
                className="w-full text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {tr("نسيت كلمة المرور؟", "Forgot password?")}
              </button>
            </form>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold mb-2 text-center text-foreground">{tr("استعادة الدخول", "Reset your password")}</h2>
            <p className="text-sm text-muted-foreground text-center mb-6">
              {tr(
                "أدخل مفتاح الاسترداد الذي نزّلته وحفظته، ثم اختر كلمة مرور جديدة.",
                "Enter the recovery key you downloaded and saved, then choose a new password.",
              )}
            </p>

            {hasRecoveryKey === null ? (
              <div className="flex justify-center py-6">
                <Icon name="spinner" className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : !hasRecoveryKey ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 space-y-2">
                  <p className="font-semibold">{tr("لا يوجد مفتاح استرداد لهذا التطبيق.", "This app has no recovery key yet.")}</p>
                  <p>
                    {tr(
                      "يُعطى المفتاح عند أول تسجيل دخول. تواصل مع الدعم الفني لإعادة تعيين كلمة المرور يدويًا.",
                      "A key is handed out at the first sign-in. Contact support for a manual password reset.",
                    )}
                  </p>
                </div>
                <button type="button" onClick={backToLogin} className={primaryButtonClass}>
                  {tr("رجوع إلى تسجيل الدخول", "Back to login")}
                </button>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tr("مفتاح الاسترداد", "Recovery key")}</label>
                  <input
                    dir="ltr"
                    autoFocus
                    className={`${inputClass} font-mono tracking-widest uppercase text-center`}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {tr("تجده في ملف atba3li-recovery-key.txt الذي نزّلته.", "You'll find it in the atba3li-recovery-key.txt file you downloaded.")}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tr("كلمة المرور الجديدة", "New password")}</label>
                  <input type="password" className={inputClass} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">{tr("تأكيد كلمة المرور", "Confirm password")}</label>
                  <input type="password" className={inputClass} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                  <p className="text-xs text-muted-foreground mt-1">{tr("8 أحرف على الأقل، وليست أرقامًا فقط.", "At least 8 characters, not all digits.")}</p>
                </div>

                {resetError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{resetError}</p>}

                <button type="submit" className={primaryButtonClass} disabled={submitting}>
                  {submitting ? tr("جارٍ الحفظ...", "Saving...") : tr("تعيين كلمة المرور والدخول", "Set password & sign in")}
                </button>
                <button type="button" onClick={backToLogin} className="w-full text-sm text-indigo-600 dark:text-indigo-400 hover:underline">
                  {tr("رجوع إلى تسجيل الدخول", "Back to login")}
                </button>
              </form>
            )}
          </>
        )}
      </div>

      <RecoveryCodeDialog
        code={newRecoveryCode}
        isRtl={isRtl}
        onClose={() => {
          setNewRecoveryCode(null);
          if (pendingToken) finishLogin(pendingToken);
        }}
      />
    </div>
  );
};

export default LoginPage;
