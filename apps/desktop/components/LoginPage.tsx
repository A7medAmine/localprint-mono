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
type RecoveryMethod = "recovery" | "email";

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
  const [options, setOptions] = useState<{ recoveryCode: boolean; email: string | null } | null>(null);
  const [method, setMethod] = useState<RecoveryMethod>("recovery");
  const [code, setCode] = useState("");
  const [emailSentTo, setEmailSentTo] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetError, setResetError] = useState("");
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

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setLoginError("");
    const result = await storageService.verifyPassword(password);
    setSubmitting(false);
    if (result.success && result.token) {
      finishLogin(result.token, result.mustChangePassword);
    } else {
      setLoginError(result.error ? translateAuthError(result.error, isRtl) : tr("كلمة المرور خاطئة", "Incorrect password"));
    }
  };

  const openForgot = async () => {
    setMode("forgot");
    setResetError("");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setEmailSentTo("");
    const opts = await storageService.getRecoveryOptions();
    setOptions(opts);
    setMethod(opts.recoveryCode || !opts.email ? "recovery" : "email");
  };

  const backToLogin = () => {
    setMode("login");
    setResetError("");
  };

  const sendEmailCode = async () => {
    setSendingEmail(true);
    setResetError("");
    try {
      const { sentTo } = await storageService.sendPasswordResetEmail();
      setEmailSentTo(sentTo);
    } catch (err) {
      setResetError(translateAuthError(errorMessage(err), isRtl));
    } finally {
      setSendingEmail(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setResetError("");
    if (!code.trim()) {
      setResetError(method === "recovery" ? tr("أدخل رمز الاسترداد.", "Enter your recovery code.") : tr("أدخل الرمز المرسل إلى بريدك.", "Enter the code from your email."));
      return;
    }
    const policy = passwordPolicyMessage(newPassword, confirmPassword, isRtl);
    if (policy) {
      setResetError(policy);
      return;
    }
    setSubmitting(true);
    try {
      const result = await storageService.resetForgottenPassword(method, code, newPassword);
      if (result.newRecoveryCode) {
        // The old code is spent; show the replacement before entering the app.
        setPendingToken(result.token);
        setNewRecoveryCode(result.newRecoveryCode);
      } else {
        finishLogin(result.token);
      }
    } catch (err) {
      setResetError(translateAuthError(errorMessage(err), isRtl));
    } finally {
      setSubmitting(false);
    }
  };

  const noRecoveryRoute = options && !options.recoveryCode && !options.email;

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
              {tr("أثبت أنك صاحب المتجر ثم اختر كلمة مرور جديدة.", "Prove it's you, then choose a new password.")}
            </p>

            {!options ? (
              <div className="flex justify-center py-6">
                <Icon name="spinner" className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : noRecoveryRoute ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 space-y-2">
                  <p className="font-semibold">{tr("لم يتم إعداد أي وسيلة استرداد بعد.", "No recovery method has been set up yet.")}</p>
                  <p>
                    {tr(
                      "لاستعادة الدخول، يجب أن يكون لديك رمز استرداد (يُنشأ من الإعدادات ← كلمة المرور) أو حساب Gmail مربوط بالتطبيق. تواصل مع الدعم الفني لإعادة التعيين يدويًا.",
                      "To recover access you need a recovery code (created in Settings → Password) or a Gmail account connected to the app. Contact support for a manual reset.",
                    )}
                  </p>
                </div>
                <button type="button" onClick={backToLogin} className={primaryButtonClass}>
                  {tr("رجوع إلى تسجيل الدخول", "Back to login")}
                </button>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-4">
                {options.recoveryCode && options.email && (
                  <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted" role="tablist">
                    {(["recovery", "email"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={method === m}
                        onClick={() => { setMethod(m); setCode(""); setResetError(""); }}
                        className={`py-1.5 rounded-md text-sm font-medium transition ${method === m ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
                      >
                        {m === "recovery" ? tr("رمز الاسترداد", "Recovery code") : tr("رمز عبر البريد", "Email code")}
                      </button>
                    ))}
                  </div>
                )}

                {method === "recovery" ? (
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">{tr("رمز الاسترداد", "Recovery code")}</label>
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
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {emailSentTo
                        ? tr(`أرسلنا رمزًا من 6 أرقام إلى ${emailSentTo}. صالح لمدة 15 دقيقة.`, `We sent a 6-digit code to ${emailSentTo}. It's valid for 15 minutes.`)
                        : tr(`سنرسل رمزًا إلى حساب Gmail المربوط (${options.email}).`, `We'll send a code to the connected Gmail account (${options.email}).`)}
                    </p>
                    <button
                      type="button"
                      onClick={sendEmailCode}
                      disabled={sendingEmail}
                      className="w-full flex items-center justify-center gap-2 border border-border rounded-lg py-2 text-sm font-medium text-foreground hover:bg-muted transition disabled:opacity-60"
                    >
                      <Icon name={sendingEmail ? "spinner" : "mail"} className={`w-4 h-4 ${sendingEmail ? "animate-spin" : ""}`} />
                      {emailSentTo ? tr("إعادة الإرسال", "Send again") : tr("إرسال الرمز", "Send code")}
                    </button>
                    {emailSentTo && (
                      <input
                        dir="ltr"
                        autoFocus
                        inputMode="numeric"
                        maxLength={6}
                        className={`${inputClass} font-mono tracking-[0.5em] text-center text-lg`}
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                        placeholder="000000"
                        autoComplete="one-time-code"
                      />
                    )}
                  </div>
                )}

                {(method === "recovery" || emailSentTo) && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{tr("كلمة المرور الجديدة", "New password")}</label>
                      <input type="password" className={inputClass} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">{tr("تأكيد كلمة المرور", "Confirm password")}</label>
                      <input type="password" className={inputClass} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password" />
                      <p className="text-xs text-muted-foreground mt-1">{tr("8 أحرف على الأقل، وليست أرقامًا فقط.", "At least 8 characters, not all digits.")}</p>
                    </div>
                  </>
                )}

                {resetError && <p className="text-sm text-red-600 dark:text-red-400 font-medium">{resetError}</p>}

                {(method === "recovery" || emailSentTo) && (
                  <button type="submit" className={primaryButtonClass} disabled={submitting}>
                    {submitting ? tr("جارٍ الحفظ...", "Saving...") : tr("تعيين كلمة المرور والدخول", "Set password & sign in")}
                  </button>
                )}
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
