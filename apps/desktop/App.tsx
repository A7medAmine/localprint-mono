import React, { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { Language, ShopSettings } from "./types";
import { TRANSLATIONS } from "./constants";
import { storageService } from "./services/storageService";
import { isNativePrintActive } from "./lib/electronPrint";
import UploadView from "./views/UploadView";
import AdminView from "./views/AdminView";
import PrintStudio from "./views/PrintStudio";
import LanguageToggle from "./components/LanguageToggle";
import ProtectedRoute from "./components/ProtectedRoute";
import LoginPage from "./components/LoginPage";
import OnboardingWizard from "./views/onboarding/OnboardingWizard";

const App: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const [lang, setLang] = useState<Language>(() => {
    const savedLang = localStorage.getItem("ps_language") as Language;
    return savedLang || "ar";
  });

  const [isAdmin, setIsAdmin] = useState<boolean>(() => {
    const token = localStorage.getItem("ps_admin_token");
    if (token) storageService.setAuthToken(token);
    return !!token;
  });

  const [settings, setSettings] = useState<ShopSettings>({
    shopName: "PrintShop Hub",
    logoUrl: null,
  });

  type ThemeMode = "light" | "dark" | "system";
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("ps_theme");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    // Migrate legacy boolean preference. Absence of the old key => "system".
    const legacy = localStorage.getItem("ps_dark_mode");
    if (legacy === "true") return "dark";
    if (legacy === "false") return "light";
    return "system";
  });

  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      // The hidden print window pins nativeTheme to light while it renders —
      // that fires a transient prefers-color-scheme change here. Ignore it so
      // printing doesn't flash/toggle the app theme (or make the UI look like
      // the cards vanished). The OS theme is still picked up after.
      if (isNativePrintActive()) return;
      setSystemPrefersDark(e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const darkMode = themeMode === "system" ? systemPrefersDark : themeMode === "dark";

  const cycleTheme = () =>
    setThemeMode((prev) => (prev === "light" ? "dark" : prev === "dark" ? "system" : "light"));

  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    const onSessionExpired = () => {
      storageService.setAuthToken(null);
      localStorage.removeItem("ps_admin_token");
      setIsAdmin(false);
      navigate("/admin/login", { replace: true });
    };
    window.addEventListener("session-expired", onSessionExpired);
    return () => window.removeEventListener("session-expired", onSessionExpired);
  }, [navigate]);

  // The default admin password makes the backend 403 every admin write until
  // it's changed; storageService dispatches "must-change-password" on that 403.
  // Send the operator to the first-run wizard to fix it.
  useEffect(() => {
    const onMustChangePassword = () => {
      navigate("/admin/setup", { replace: true });
    };
    window.addEventListener("must-change-password", onMustChangePassword);
    return () => window.removeEventListener("must-change-password", onMustChangePassword);
  }, [navigate]);

  useEffect(() => {
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    localStorage.setItem("ps_language", lang);
    window.dispatchEvent(new CustomEvent("ps:langchange", { detail: lang }));
  }, [lang]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem("ps_theme", themeMode);
    // Clear the legacy key so a stale value never overrides the tri-state one.
    localStorage.removeItem("ps_dark_mode");
  }, [themeMode]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const serverSettings = await storageService.getSettings();
        setSettings(serverSettings);
        document.title = serverSettings.shopName;
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    };
    loadSettings();
  }, []);

  // Redirect / to /upload
  useEffect(() => {
    if (location.pathname === "/") {
      navigate("/upload", { replace: true });
    }
  }, [location.pathname, navigate]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (isAdmin) {
          navigate("/admin/dashboard");
        } else {
          navigate("/admin/login");
        }
      }
      if (e.altKey && e.key === "a") {
        e.preventDefault();
        if (isAdmin) {
          navigate("/admin/dashboard");
        } else {
          navigate("/admin/login");
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "u") {
        e.preventDefault();
        navigate("/upload");
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        if (isAdmin) {
          navigate("/admin/studio");
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        if (isAdmin && location.pathname === "/admin/dashboard") {
          window.dispatchEvent(new CustomEvent("ps:new-job"));
        }
      }
      if (e.key === "Escape") {
        if (location.pathname.startsWith("/admin")) {
          navigate("/upload");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAdmin, navigate, location.pathname]);

  const handleLogout = () => {
    fetch("/api/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${localStorage.getItem("ps_admin_token")}`,
      },
    }).catch(() => {});
    storageService.setAuthToken(null);
    localStorage.removeItem("ps_admin_token");
    setIsAdmin(false);
    navigate("/upload", { replace: true });
  };

  const handleToggleMode = () => {
    setIsTransitioning(true);
    setTimeout(() => {
      if (isAdmin) {
        handleLogout();
      } else {
        navigate("/admin/login");
      }
      setIsTransitioning(false);
    }, 150);
  };

  const isStudio = location.pathname === "/admin/studio";
  const isAdminRoute = location.pathname.startsWith("/admin");

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-gray-950 flex flex-col antialiased font-sans selection:bg-indigo-100 dark:selection:bg-indigo-900/40 selection:text-indigo-900 dark:selection:text-indigo-200">
      {!isAdminRoute && (
        <nav
          dir="ltr"
          style={{ direction: "ltr", flexDirection: "row" }}
          className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-b border-gray-100/50 dark:border-gray-800/50 px-6 py-2.5 flex items-center justify-between sticky top-0 z-50 shadow-sm dark:shadow-gray-900/30"
        >
          <div className="flex items-center gap-3 cursor-pointer" style={{ direction: "ltr" }} onClick={() => navigate("/upload")}>
            <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white overflow-hidden shadow-sm">
              {settings.logoUrl ? (
                <img src={settings.logoUrl} alt="Logo" className="w-full h-full object-contain" />
              ) : (
                <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm-1 9H8v2h4v-2z" clipRule="evenodd" />
                </svg>
              )}
            </div>
            <div className="flex flex-col justify-center">
              <span dir="auto" className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100 truncate max-w-[150px] sm:max-w-[300px]">
                {settings.shopName || TRANSLATIONS.appTitle[lang]}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={cycleTheme}
              className="p-2 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800 transition-all active:scale-95"
              aria-label={
                themeMode === "light"
                  ? lang === "ar" ? "الوضع الفاتح" : "Light mode"
                  : themeMode === "dark"
                  ? lang === "ar" ? "الوضع الليلي" : "Dark mode"
                  : lang === "ar" ? "حسب النظام" : "System theme"
              }
              title={
                themeMode === "light"
                  ? lang === "ar" ? "فاتح" : "Light"
                  : themeMode === "dark"
                  ? lang === "ar" ? "داكن" : "Dark"
                  : lang === "ar" ? "حسب النظام" : "System"
              }
            >
              {themeMode === "light" ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : themeMode === "dark" ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              )}
            </button>
            <LanguageToggle currentLang={lang} onToggle={setLang} />
            {isAdmin && (
              <button
                onClick={handleToggleMode}
                className="text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all flex items-center gap-2 px-4 py-2 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:shadow-sm dark:hover:shadow-indigo-900/20 border border-transparent hover:border-indigo-100 dark:hover:border-indigo-800/50 active:scale-95"
              >
                {isStudio ? (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                    {lang === "ar" ? "لوحة التحكم" : "Dashboard"}
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                    {lang === "ar" ? "صفحة الرفع" : "Back to Upload"}
                  </>
                )}
              </button>
            )}
          </div>
        </nav>
      )}

      <main className={`flex-grow flex flex-col transition-opacity duration-150 ${isAdminRoute ? "" : "container mx-auto py-6 px-4"} ${isTransitioning ? "opacity-0" : "opacity-100"}`}>
        {/* No key={lang} here — that was remounting every route (including
            the PDF Studio) on language change and wiping local state like
            the loaded PDF. `useLanguage` already re-renders in place. */}
        <div className="flex-1 flex flex-col">
          <Routes>
            <Route path="/upload" element={<UploadView lang={lang} shopSettings={settings} />} />
            <Route
              path="/admin"
              element={
                isAdmin ? <Navigate to="/admin/dashboard" replace /> : <Navigate to="/admin/login" replace />
              }
            />
            <Route
              path="/admin/login"
              element={
                isAdmin ? <Navigate to="/admin/dashboard" replace /> : <LoginPage lang={lang} onLoginSuccess={() => setIsAdmin(true)} />
              }
            />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute isAdmin={isAdmin}>
                  <AdminView lang={lang} onLogout={handleLogout} currentSettings={settings} onSettingsUpdate={setSettings} darkMode={darkMode} themeMode={themeMode} onToggleDarkMode={cycleTheme} onToggleLang={setLang} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/studio"
              element={
                <ProtectedRoute isAdmin={isAdmin}>
                  <PrintStudio
                    darkMode={darkMode}
                    themeMode={themeMode}
                    onToggleDarkMode={cycleTheme}
                    lang={lang}
                    onToggleLang={setLang}
                    currentSettings={settings}
                  />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/setup"
              element={
                <ProtectedRoute isAdmin={isAdmin}>
                  <OnboardingWizard lang={lang} currentSettings={settings} onSettingsUpdate={setSettings} />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/upload" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
};

export default App;
