import React, { Suspense, lazy, useState, useEffect } from "react";
import { Routes, Route, useParams, Link, useLocation } from "react-router-dom";
import { Language, ShopSettings } from "./types";
import { emitAppEvent } from "@atba3li/shared/lib/appEvents";
import { readPref, writePref } from "@atba3li/shared/lib/prefs";
import { TRANSLATIONS } from "./constants";
import { storageService } from "./services/storageService";
// The upload flow pulls in pdf.js and xlsx for previews; the account page is a
// separate concern entirely. Neither belongs in the first paint of the other.
const UploadView = lazy(() => import("./views/UploadView"));
const AccountView = lazy(() => import("./views/AccountView"));

const RouteFallback: React.FC = () => (
  <div className="flex-1 flex items-center justify-center py-20" role="status" aria-live="polite">
    <div className="w-8 h-8 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin dark:border-indigo-900 dark:border-t-indigo-400" />
  </div>
);
import LanguageToggle from "./components/LanguageToggle";
import { useAuth } from "./hooks/useAuth";
import { isCustomerAuthConfigured } from "./services/supabaseClient";
import { Icon } from "./components/ui/icon";

const NoShopSpecified: React.FC<{ isRtl: boolean }> = ({ isRtl }) => (
  <div className="max-w-md mx-auto mt-16 text-center text-muted-foreground">
    <p className="text-lg font-semibold">
      {isRtl ? "لم يتم تحديد متجر" : "No shop specified"}
    </p>
    <p className="text-sm mt-2">
      {isRtl
        ? "استخدم رابط الرفع الخاص بالمتجر الذي حصلت عليه من صاحب المحل."
        : "Use the shop's upload link you were given."}
    </p>
  </div>
);

const UploadRoute: React.FC<{
  lang: Language;
  onSettingsLoaded: (s: ShopSettings) => void;
  onShopVisited: (slug: string) => void;
}> = ({ lang, onSettingsLoaded, onShopVisited }) => {
  const { shopSlug } = useParams<{ shopSlug: string }>();
  const [settings, setSettings] = useState<ShopSettings | undefined>(undefined);

  useEffect(() => {
    if (!shopSlug) return;
    onShopVisited(shopSlug);
    (async () => {
      try {
        const serverSettings = await storageService.getSettings(shopSlug);
        setSettings(serverSettings);
        onSettingsLoaded(serverSettings);
        document.title = serverSettings.shopName;
      } catch (error) {
        console.error("Failed to load settings:", error);
      }
    })();
  }, [shopSlug]);

  if (!shopSlug) {
    return <NoShopSpecified isRtl={lang === "ar"} />;
  }

  return <UploadView lang={lang} shopSlug={shopSlug} shopSettings={settings} />;
};

const App: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const isAccountRoute = location.pathname === "/account";
  const [lang, setLang] = useState<Language>(() => {
    const savedLang = readPref("language") as Language;
    return savedLang || "ar";
  });

  const [settings, setSettings] = useState<ShopSettings>({
    shopName: "Atba3li",
    logoUrl: null,
  });

  const [lastShopSlug, setLastShopSlug] = useState<string | null>(() =>
    readPref("lastShopSlug"),
  );
  const handleShopVisited = (slug: string) => {
    setLastShopSlug(slug);
    writePref("lastShopSlug", slug);
  };

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    return readPref("legacyDarkMode") === "true";
  });

  useEffect(() => {
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    writePref("language", lang);
    emitAppEvent("ps:langchange", lang);
  }, [lang]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    writePref("legacyDarkMode", String(darkMode));
  }, [darkMode]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] dark:bg-gray-950 flex flex-col antialiased font-sans selection:bg-indigo-100 dark:selection:bg-indigo-900/40 selection:text-indigo-900 dark:selection:text-indigo-200">
      <nav
        dir="ltr"
        style={{ direction: "ltr", flexDirection: "row" }}
        className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-xl border-b border-gray-100/50 dark:border-gray-800/50 px-6 py-2.5 flex items-center justify-between sticky top-0 z-50 shadow-sm dark:shadow-gray-900/30"
      >
        {(() => {
          const brand = (
            <>
              <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white overflow-hidden shadow-sm shrink-0">
                {settings.logoUrl ? (
                  <img src={settings.logoUrl} alt="Logo" className="w-full h-full object-contain" />
                ) : (
                  <Icon name="print" className="w-6 h-6" />
                )}
              </div>
              <div className="flex flex-col justify-center min-w-0">
                <span dir="auto" className="text-xl font-bold tracking-tight text-foreground truncate max-w-[150px] sm:max-w-[300px]">
                  {settings.shopName || TRANSLATIONS.appTitle[lang]}
                </span>
              </div>
            </>
          );
          return lastShopSlug ? (
            <Link to={`/s/${lastShopSlug}/upload`} className="flex items-center gap-3 min-w-0" style={{ direction: "ltr" }}>
              {brand}
            </Link>
          ) : (
            <div className="flex items-center gap-3 min-w-0" style={{ direction: "ltr" }}>
              {brand}
            </div>
          );
        })()}

        <div className="flex items-center gap-3">
          <button
            onClick={() => setDarkMode(!darkMode)}
            className="p-2 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-all active:scale-95"
            aria-label={lang === "ar" ? "الوضع الليلي" : "Dark mode"}
          >
            {darkMode ? (
              <Icon name="sun" className="w-5 h-5" />
            ) : (
              <Icon name="moon" className="w-5 h-5" />
            )}
          </button>
          <LanguageToggle currentLang={lang} onToggle={setLang} />
          {isCustomerAuthConfigured && (
            <Link
              to="/account"
              className={`p-2 rounded-xl transition-all active:scale-95 ${
                isAccountRoute
                  ? "text-indigo-600 bg-indigo-50 dark:text-indigo-400 dark:bg-indigo-900/30"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
              }`}
              aria-label={lang === "ar" ? "حسابي" : "My account"}
              title={user?.email || (lang === "ar" ? "تسجيل الدخول" : "Sign in")}
            >
              <Icon name="user" className="w-5 h-5" />
            </Link>
          )}
        </div>
      </nav>

      <main className="flex-grow flex flex-col transition-opacity duration-150 container mx-auto py-6 px-4">
        <div key={lang} className="animate-[langFadeIn_0.25s_ease-out] flex-1 flex flex-col">
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/s/:shopSlug/upload" element={<UploadRoute lang={lang} onSettingsLoaded={setSettings} onShopVisited={handleShopVisited} />} />
            <Route path="/account" element={<AccountView lang={lang} onToggleLang={setLang} />} />
            <Route path="*" element={<NoShopSpecified isRtl={lang === "ar"} />} />
          </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
};

export default App;
