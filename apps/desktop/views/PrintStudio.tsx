import React, { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import CardIDTool from "./CardIDTool";
import PDFJobManager from "./PDFJobManager";
import { useLanguage } from "../lib/useLanguage";
import { Toaster } from "../components/ui/toaster";
import LanguageToggle from "../components/LanguageToggle";
import type { Language, ShopSettings } from "../types";
import { TRANSLATIONS } from "../constants";

type StudioTab = "cards" | "pdf";

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
  darkMode,
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
  const tab: StudioTab = urlTab === "pdf" || urlTab === "cards" ? urlTab : "cards";
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
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm-1 9H8v2h4v-2z" clipRule="evenodd" />
            </svg>
          )}
        </div>
        {!collapsed && (
          <span dir="auto" className="text-base font-bold tracking-tight text-gray-900 dark:text-gray-100 truncate flex-1 min-w-0">
            {shopName}
          </span>
        )}

        {/* Collapse toggle — desktop only */}
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="hidden md:inline-flex p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
            aria-label={isRtl ? "طي" : "Collapse"}
          >
            <svg className="w-4 h-4 rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        )}

        {/* Close drawer — mobile only */}
        <button
          onClick={() => setMobileOpen(false)}
          className="md:hidden ml-auto p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
          aria-label="Close"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M6 18L18 6" />
          </svg>
        </button>
      </div>

      {/* Expand button when collapsed (desktop) */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="hidden md:flex mx-auto mb-2 p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
          aria-label={isRtl ? "توسيع" : "Expand"}
        >
          <svg className="w-4 h-4 rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
          </svg>
        </button>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* STUDIO */}
        {!collapsed && (
          <div className="px-4 pt-2 pb-1">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
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
            <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">
              {isRtl ? "أدوات" : "TOOLS"}
            </span>
          </div>
        )}
        <nav className={collapsed ? "px-2 py-2 space-y-1" : "px-3 py-2 space-y-0.5"}>
          <button
            onClick={() => navigate("/admin/dashboard")}
            className={`w-full flex items-center gap-3 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors ${
              collapsed ? "px-2.5 py-2.5 justify-center" : "px-3.5 py-2.5"
            }`}
            title={collapsed ? (isRtl ? "لوحة التحكم" : "Dashboard") : undefined}
          >
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            {!collapsed && <span className="truncate">{isRtl ? "لوحة التحكم" : "Dashboard"}</span>}
          </button>
        </nav>

        {/* Help card — hide when collapsed */}
        {!collapsed && (
          <div className="px-3 mt-4">
            <div className="bg-white/60 dark:bg-white/[0.06] rounded-xl p-3.5 border border-gray-200 dark:border-white/10">
              <div className="flex items-start gap-2.5 mb-2.5">
                <svg className="w-4 h-4 mt-0.5 text-gray-400 dark:text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 11-12.728 0 9 9 0 0112.728 0zM12 8v4m0 4h.01" />
                </svg>
                <div>
                  <p className="text-xs font-medium text-gray-700 dark:text-gray-300 leading-tight">
                    {isRtl ? "تحتاج مساعدة؟" : "Need help?"}
                  </p>
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 leading-tight">
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
        className={`shrink-0 border-t border-gray-200 dark:border-gray-800 px-3 py-3 flex items-center gap-2 ${
          collapsed ? "flex-col" : ""
        }`}
      >
        <button
          onClick={onToggleDarkMode}
          className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
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
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : themeMode === "dark" ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          )}
        </button>
        {collapsed ? (
          <button
            onClick={() => onToggleLang(lang === "en" ? "ar" : "en")}
            className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
            title={lang === "en" ? "عربي" : "English"}
          >
            <span className="text-xs font-bold">{lang === "en" ? "ع" : "EN"}</span>
          </button>
        ) : (
          <div className="ml-auto rtl:ml-0 rtl:mr-auto">
            <LanguageToggle currentLang={lang} onToggle={onToggleLang} />
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className={`flex h-screen overflow-hidden bg-[#F8FAFC] dark:bg-gray-950 text-gray-900 dark:text-gray-100 ${isRtl ? "font-['IBMPlexArabic']" : ""}`}>
      {/* Desktop sidebar (inline) */}
      <aside
        className={`hidden md:flex flex-col bg-gray-50 dark:bg-[#111] border-gray-200 dark:border-gray-800 transition-[width] duration-200 shrink-0 ${
          isRtl ? "border-l" : "border-r"
        } ${collapsed ? "w-[64px]" : "w-[240px]"}`}
      >
        {Sidebar}
      </aside>

      {/* Mobile drawer + backdrop */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`md:hidden fixed top-0 bottom-0 z-50 w-72 max-w-[85vw] flex flex-col bg-gray-50 dark:bg-[#111] shadow-xl transition-transform duration-200 ${
          isRtl ? "right-0 border-l border-gray-200 dark:border-gray-800" : "left-0 border-r border-gray-200 dark:border-gray-800"
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
        <header className="md:hidden flex items-center justify-between gap-3 h-14 px-3 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
            aria-label="Menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
            {t(tab === "cards" ? "cardsTab" : "pdfTab")}
          </span>
          <div className="w-9" />
        </header>

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto bg-white dark:bg-gray-900">
          <div className={`p-3 sm:p-4 lg:p-6 ${isRtl ? "text-right" : ""}`} dir={isRtl ? "rtl" : "ltr"}>
            {tab === "cards" ? <CardIDTool /> : <PDFJobManager />}
          </div>
        </main>
      </div>
      <Toaster />
    </div>
  );
};

export default PrintStudio;
