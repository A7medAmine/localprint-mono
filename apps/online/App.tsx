import React, { Suspense, lazy, useState, useEffect } from "react";
import { Routes, Route, Navigate, useParams, Link, useLocation } from "react-router-dom";
import { Language, ShopSettings } from "./types";
import { emitAppEvent } from "@atba3li/shared/lib/appEvents";
import { readPref, writePref } from "@atba3li/shared/lib/prefs";
import { TRANSLATIONS } from "./constants";
import { storageService, PublicShop } from "./services/storageService";
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
  const [shops, setShops] = useState<PublicShop[] | null>(null);
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
    <div className="w-full max-w-5xl mx-auto mt-8 px-1">
      <div className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
          <Icon name="print" className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          {isRtl
            ? `${shops.length} ${shops.length === 1 ? "محل متاح" : "محل متاح"}`
            : `${shops.length} ${shops.length === 1 ? "shop" : "shops"} available`}
        </span>
        <h1 className="mt-4 text-2xl sm:text-3xl font-bold text-foreground">
          {isRtl ? "اختر متجرًا" : "Choose a shop"}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          {isRtl
            ? "اختر المحل الذي تريد الطباعة عنده، تواصل معه مباشرة أو ابدأ برفع ملفاتك."
            : "Pick the print shop you want to order from — contact it directly or start uploading right away."}
        </p>
      </div>

      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shops.map((shop) => (
          <li key={shop.slug}>
            <ShopCard shop={shop} isRtl={isRtl} />
          </li>
        ))}
      </ul>
    </div>
  );
};

// One storefront card. The logo is the card's anchor, so it gets a real frame
// instead of being squeezed into an avatar: shops upload wildly different
// aspect ratios (wide wordmarks, square marks), and `object-contain` inside a
// fixed box is the only thing that keeps both readable. Shops with no logo get
// the shop's first letter rather than a generic icon, so the cards still
// differ from each other at a glance.
const ShopCard: React.FC<{ shop: PublicShop; isRtl: boolean }> = ({ shop, isRtl }) => {
  const phones = (shop.phoneNumbers || []).filter(Boolean);
  const hasContact = phones.length > 0 || !!shop.email;
  // A shop can have a logo recorded but the image fail to load (mid-sync, or a
  // stale record). Fall back to the lettermark rather than a broken-image icon.
  const [logoBroken, setLogoBroken] = useState(false);
  const showLogo = !!shop.logoUrl && !logoBroken;

  return (
    <div className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg dark:hover:border-indigo-800/50">
      <Link to={`/s/${shop.slug}/upload`} className="block">
        <div className="relative flex h-28 items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-50 via-white to-indigo-100/70 dark:from-indigo-950/40 dark:via-gray-900 dark:to-indigo-900/20">
          {showLogo ? (
            <img
              src={shop.logoUrl as string}
              alt=""
              loading="lazy"
              onError={() => setLogoBroken(true)}
              className="max-h-20 max-w-[70%] object-contain drop-shadow-sm transition-transform duration-300 group-hover:scale-105"
            />
          ) : (
            <span
              dir="auto"
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600 text-2xl font-bold text-white shadow-sm"
            >
              {(shop.name || "?").trim().charAt(0).toUpperCase()}
            </span>
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <Link to={`/s/${shop.slug}/upload`} className="block">
            <h2 dir="auto" className="truncate text-base font-bold text-foreground">
              {shop.name}
            </h2>
          </Link>
          <p dir="ltr" className="mt-0.5 truncate text-xs text-muted-foreground">
            /s/{shop.slug}
          </p>
        </div>

        {(shop.address || shop.workingHours) && (
          <div className="space-y-1.5 text-xs text-muted-foreground">
            {shop.address && (
              <p className="flex items-start gap-2">
                <Icon name="map-pin" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                <span dir="auto" className="line-clamp-2">{shop.address}</span>
              </p>
            )}
            {shop.workingHours && (
              <p className="flex items-start gap-2">
                <Icon name="clock" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                <span dir="auto" className="line-clamp-2">{shop.workingHours}</span>
              </p>
            )}
          </div>
        )}

        {hasContact && (
          <div className="flex flex-wrap gap-1.5">
            {phones.map((phone) => (
              <a
                key={phone}
                href={`tel:${phone.replace(/\s+/g, "")}`}
                dir="ltr"
                className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
              >
                <Icon name="phone" className="h-3 w-3" />
                {phone}
              </a>
            ))}
            {shop.email && (
              <a
                href={`mailto:${shop.email}`}
                dir="ltr"
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-indigo-50 hover:text-indigo-700 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
              >
                <Icon name="mail" className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[140px]">{shop.email}</span>
              </a>
            )}
          </div>
        )}

        <Link
          to={`/s/${shop.slug}/upload`}
          className="mt-auto inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-indigo-700 active:scale-[0.99]"
        >
          <Icon name="upload" className="h-4 w-4" />
          {isRtl ? "ارفع ملفاتك" : "Upload files"}
        </Link>
      </div>
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
