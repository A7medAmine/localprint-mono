import React, { Suspense, lazy, useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
// Same chunks AdminView uses — only the selected tool's code is fetched.
const CardIDTool = lazy(() => import("./CardIDTool"));
const PhotoBatchTool = lazy(() => import("./PhotoBatchTool"));
const PDFJobManager = lazy(() => import("./PDFJobManager"));
import { useLanguage } from "../lib/useLanguage";
import { Toaster } from "../components/ui/toaster";
import LanguageToggle from "../components/LanguageToggle";
import type { Language, ShopSettings } from "../types";
import { TRANSLATIONS } from "../constants";
import { Icon } from "../components/ui/icon";

type StudioTab = "cards" | "pdf" | "photos";

const studioNavItems: { id: StudioTab; icon: string; labelKey: string }[] = [
  {
    id: "cards",
    icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z",
    labelKey: "cardsTab",
  },
  {
    id: "pdf",
    icon: "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
    labelKey: "pdfTab",
  },
  {
    id: "photos",
    icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z",
    labelKey: "photosTab",
  },
];

interface PrintStudioProps {
  darkMode: boolean;
  themeMode?: "light" | "dark" | "system";
  onToggleDarkMode: () => void;
  lang: Language;
  onToggleLang: (lang: Language) => void;
  currentSettings: ShopSettings;
}

const PrintStudio: React.FC<PrintStudioProps> = ({
  darkMode: _darkMode,
  themeMode = "system",
  onToggleDarkMode,
  lang,
  onToggleLang,
  currentSettings,
}) => {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const isRtl = lang === "ar";
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab") as StudioTab | null;
  const tab: StudioTab = urlTab === "pdf" || urlTab === "cards" || urlTab === "photos" ? urlTab : "cards";
  const setTab = (next: StudioTab) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "cards") p.delete("tab");
        else p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  };
  // Tools that have been opened at least once — they stay mounted from then
  // on so their in-progress work survives tool switches.
  const [visited, setVisited] = useState<Set<StudioTab>>(() => new Set<StudioTab>([tab]));
  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  // Desktop-only: collapse the sidebar to icons.
  const [collapsed, setCollapsed] = useState(false);
  // Mobile-only: open/close the drawer.
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem("ps_edit_job")) {
      setTab("pdf");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close mobile drawer whenever the tab changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [tab]);

  const shopName = currentSettings.shopName || TRANSLATIONS.appTitle[lang];

  const Sidebar = (
    <>
      {/* Brand + collapse (desktop) / close (mobile) */}
      <div className="flex items-center gap-3 px-4 py-4 h-16 shrink-0">
        <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center text-white overflow-hidden shadow-sm flex-shrink-0">
          {currentSettings.logoUrl ? (
            <img src={currentSettings.logoUrl} alt="Logo" className="w-full h-full object-contain" />
          ) : (
            <Icon name="print" className="w-5 h-5" />
          )}
        </div>
        {!collapsed && (
          <span dir="auto" className="text-base font-bold tracking-tight text-foreground truncate flex-1 min-w-0">
            {shopName}
          </span>
        )}

        {/* Collapse toggle — desktop only */}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="hidden md:inline-flex p-1.5 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
            aria-label={isRtl ? "طي" : "Collapse"}
          >
            <Icon name="chevrons-left" className="w-4 h-4 rtl:rotate-180" />
          </button>
        )}

        {/* Close drawer — mobile only */}
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden ms-auto p-1.5 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
          aria-label="Close"
        >
          <Icon name="x" className="w-5 h-5" />
        </button>
      </div>

      {/* Expand button when collapsed (desktop) */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="hidden md:flex mx-auto mb-2 p-1.5 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
          aria-label={isRtl ? "توسيع" : "Expand"}
        >
          <Icon name="chevrons-right" className="w-4 h-4 rtl:rotate-180" />
        </button>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* STUDIO */}
        {!collapsed && (
          <div className="px-4 pt-2 pb-1">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {isRtl ? "الاستوديو" : "STUDIO"}
            </span>
          </div>
        )}
        <nav className={collapsed ? "px-2 py-2 space-y-1" : "px-3 py-2 space-y-0.5"}>
          {studioNavItems.map((item) => {
            const isActive = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`w-full flex items-center gap-3 rounded-xl text-sm font-medium transition-colors ${
                  collapsed ? "px-2.5 py-2.5 justify-center" : "px-3.5 py-2.5"
                } ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/20"
                    : "text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
                }`}
                title={collapsed ? t(item.labelKey) : undefined}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d={item.icon} />
                </svg>
                {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
              </button>
            );
          })}
        </nav>

        {/* TOOLS */}
        {!collapsed && (
          <div className="px-4 pt-3 pb-1">
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {isRtl ? "أدوات" : "TOOLS"}
            </span>
          </div>
        )}
        <nav className={collapsed ? "px-2 py-2 space-y-1" : "px-3 py-2 space-y-0.5"}>
          <button
            onClick={() => navigate("/admin/dashboard")}
            className={`w-full flex items-center gap-3 rounded-xl text-sm font-medium text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors ${
              collapsed ? "px-2.5 py-2.5 justify-center" : "px-3.5 py-2.5"
            }`}
            title={collapsed ? (isRtl ? "لوحة التحكم" : "Dashboard") : undefined}
          >
            <Icon name="home" className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="truncate">{isRtl ? "لوحة التحكم" : "Dashboard"}</span>}
          </button>
        </nav>

        {/* Help card — hide when collapsed */}
        {!collapsed && (
          <div className="px-3 mt-4">
            <div className="bg-white/60 dark:bg-white/[0.06] rounded-xl p-3.5 border border-gray-200 dark:border-white/10">
              <div className="flex items-start gap-2.5 mb-2.5">
                <Icon name="alert-circle" className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium text-foreground leading-tight">
                    {isRtl ? "تحتاج مساعدة؟" : "Need help?"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-tight">
                    {isRtl ? "فريقنا جاهز للمساعدة" : "Our team is here to help"}
                  </p>
                </div>
              </div>
              <button className="w-full text-xs font-semibold py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors">
                {isRtl ? "اتصل بالدعم" : "Contact Support"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom toggles */}
      <div
        className={`shrink-0 border-t border-border px-3 py-3 flex items-center gap-2 ${
          collapsed ? "flex-col" : ""
        }`}
      >
        <button
          onClick={onToggleDarkMode}
          className="p-2 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
          aria-label={
            themeMode === "light"
              ? isRtl ? "الوضع الفاتح" : "Light mode"
              : themeMode === "dark"
              ? isRtl ? "الوضع الليلي" : "Dark mode"
              : isRtl ? "حسب النظام" : "System theme"
          }
          title={
            themeMode === "light"
              ? isRtl ? "فاتح" : "Light"
              : themeMode === "dark"
              ? isRtl ? "داكن" : "Dark"
              : isRtl ? "حسب النظام" : "System"
          }
        >
          {themeMode === "light" ? (
            <Icon name="sun" className="w-4 h-4" />
          ) : themeMode === "dark" ? (
            <Icon name="moon" className="w-4 h-4" />
          ) : (
            <Icon name="monitor" className="w-4 h-4" />
          )}
        </button>
        {collapsed ? (
          <button
            onClick={() => onToggleLang(lang === "en" ? "ar" : "en")}
            className="p-2 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
            title={lang === "en" ? "عربي" : "English"}
          >
            <span className="text-xs font-bold">{lang === "en" ? "ع" : "EN"}</span>
          </button>
        ) : (
          <div className="ms-auto">
            <LanguageToggle currentLang={lang} onToggle={onToggleLang} />
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className={`flex h-screen overflow-hidden bg-[#F8FAFC] dark:bg-gray-950 text-foreground ${isRtl ? "font-['Rubik']" : ""}`}>
      {/* Desktop sidebar (inline) */}
      <aside
        className={`hidden md:flex flex-col bg-gray-50 dark:bg-[#111] border-border transition-[width] duration-200 shrink-0 ${
          isRtl ? "border-l" : "border-r"
        } ${collapsed ? "w-[64px]" : "w-[240px]"}`}
      >
        {Sidebar}
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <button
          type="button"
          aria-label={isRtl ? "إغلاق القائمة" : "Close menu"}
          className="md:hidden fixed inset-0 bg-black/40 z-40 cursor-default"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`md:hidden fixed top-0 bottom-0 z-50 w-72 max-w-[85vw] flex flex-col bg-gray-50 dark:bg-[#111] shadow-xl transition-transform duration-200 ${
          isRtl ? "right-0 border-l border-border" : "left-0 border-r border-border"
        } ${
          mobileOpen
            ? "translate-x-0"
            : isRtl
              ? "translate-x-full"
              : "-translate-x-full"
        }`}
      >
        {Sidebar}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between gap-3 h-14 px-3 bg-card border-b border-border shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06]"
            aria-label="Menu"
          >
            <Icon name="menu" className="w-5 h-5" />
          </button>
          <span className="text-sm font-semibold text-foreground truncate">
            {t(tab === "cards" ? "cardsTab" : tab === "photos" ? "photosTab" : "pdfTab")}
          </span>
          <div className="w-9" />
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto bg-card">
          <div className="p-3 sm:p-4 lg:p-6" dir={isRtl ? "rtl" : "ltr"}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
                  <div className="w-7 h-7 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin dark:border-indigo-900 dark:border-t-indigo-400" />
                </div>
              }
            >
              {/* Every visited tool stays mounted and is only hidden, so
                  switching tools never throws away loaded images, pages or
                  options. Tools are still mounted lazily on first visit. */}
              {visited.has("cards") && (
                <div hidden={tab !== "cards"}>
                  <CardIDTool />
                </div>
              )}
              {visited.has("photos") && (
                <div hidden={tab !== "photos"}>
                  <PhotoBatchTool />
                </div>
              )}
              {visited.has("pdf") && (
                <div hidden={tab !== "pdf"}>
                  <PDFJobManager />
                </div>
              )}
            </Suspense>
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
};

export default PrintStudio;
