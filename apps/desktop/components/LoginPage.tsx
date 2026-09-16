import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Language } from "../types";
import { TRANSLATIONS } from "../constants";
import { storageService } from "../services/storageService";
import { Icon } from "./ui/icon";
import { writePref } from "@atba3li/shared/lib/prefs";

interface LoginPageProps {
  lang: Language;
  onLoginSuccess: (token: string) => void;
}

const LoginPage: React.FC<LoginPageProps> = ({ lang, onLoginSuccess }) => {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await storageService.verifyPassword(password);
    if (result.success && result.token) {
      storageService.setAuthToken(result.token);
      writePref("adminToken", result.token);
      onLoginSuccess(result.token);
      // A default/temporary password sends the operator through the first-run
      // wizard (which forces a password change) before the dashboard.
      if (result.mustChangePassword) {
        navigate("/admin/setup", { replace: true });
      } else {
        navigate("/admin/dashboard", { replace: true });
      }
    } else {
      setLoginError(true);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-16">
      <div className="bg-card p-8 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-border">
        <h2 className="text-2xl font-bold mb-6 text-center text-foreground">
          {TRANSLATIONS.adminLogin[lang]}
        </h2>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              {TRANSLATIONS.password[lang]}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoFocus
                className="w-full px-4 py-2 pe-10 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
              aria-label={lang === "ar" ? "إظهار كلمة المرور" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground transition"
                tabIndex={-1}
              >
                {showPassword ? (
                  <Icon name="eye-off" className="w-4 h-4" />
                ) : (
                  <Icon name="eye" className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
          {loginError && (
            <p className="text-sm text-red-600 font-medium">
              {lang === "ar" ? "كلمة المرور خاطئة" : "Incorrect password"}
            </p>
          )}
          <button
            type="submit"
            className="w-full bg-gray-900 dark:bg-indigo-600 text-white font-bold py-2 rounded-lg hover:bg-black dark:hover:bg-indigo-700 transition"
          >
            {TRANSLATIONS.loginBtn[lang]}
          </button>
        </form>
      </div>
    </div>
  );
};

export default LoginPage;
