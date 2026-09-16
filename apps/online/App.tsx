import React, { Suspense, lazy, useState, useEffect } from "react";
import { Routes, Route, Navigate, useParams, Link, useLocation } from "react-router-dom";
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

// Landing on the platform root (no slug) is not an error — it is a customer
// who does not have the shop's link. List the active shops so they can pick
// one; fall back to the "no shop specified" note if the list is empty or the
// request fails.
const ShopDirectory: React.FC<{ isRtl: boolean }> = ({ isRtl }) => {
  const [shops, setShops] = useState<{ slug: string; name: string }[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await storageService.listShops();
        if (!cancelled) setShops(list);
      } catch (error) {
        console.error("Failed to load shop directory:", error);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed || (shops && shops.length === 0)) {
    return <NoShopSpecified isRtl={isRtl} />;
  }

  if (!shops) {
    return <RouteFallback />;
  }

  return (
    <div className="max-w-2xl mx-auto mt-12 w-full px-2">
      <h1 className="text-2xl font-bold text-foreground text-center">
        {isRtl ? "اختر متجرًا" : "Choose a shop"}
      </h1>
      <p className="text-sm text-muted-foreground text-center mt-2">
        {isRtl
          ? "اختر المحل الذي تريد الطباعة عنده لبدء رفع ملفاتك."
          : "Pick the print shop you want to order from to start uploading."}
      </p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {shops.map((shop) => (
          <li key={shop.slug}>
            <Link
              to={`/s/${shop.slug}/upload`}
              className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition-all hover:border-indigo-200 hover:shadow-md active:scale-[0.99] dark:hover:border-indigo-800/50"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
                <Icon name="print" className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span dir="auto" className="block truncate font-semibold text-foreground">
                  {shop.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">/s/{shop.slug}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};

// A bare shop link (/s/:slug) — or anything under it that isn't a real page —
// is a customer who scanned the QR or typed the short URL. Send them to the
// upload page instead of the "no shop specified" dead end.
const ShopRootRedirect: React.FC = () => {
  const { shopSlug } = useParams<{ shopSlug: string }>();
  return <Navigate to={`/s/${shopSlug}/upload`} replace />;
};

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
            <Route path="/s/:shopSlug" element={<ShopRootRedirect />} />
            <Route path="/s/:shopSlug/*" element={<ShopRootRedirect />} />
            <Route path="/account" element={<AccountView lang={lang} onToggleLang={setLang} />} />
            <Route path="*" element={<ShopDirectory isRtl={lang === "ar"} />} />
          </Routes>
          </Suspense>
        </div>
      </main>
    </div>
  );
};

export default App;
