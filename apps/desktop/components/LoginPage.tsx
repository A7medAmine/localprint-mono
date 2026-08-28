import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Language } from "../types";
import { TRANSLATIONS } from "../constants";
import { storageService } from "../services/storageService";

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
      localStorage.setItem("ps_admin_token", result.token);
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
      <div className="bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl dark:shadow-2xl dark:shadow-black/40 border border-gray-100 dark:border-gray-700">
        <h2 className="text-2xl font-bold mb-6 text-center text-gray-900 dark:text-gray-100">
          {TRANSLATIONS.adminLogin[lang]}
        </h2>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {TRANSLATIONS.password[lang]}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                autoFocus
                className="w-full px-4 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 outline-none bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition"
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
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
