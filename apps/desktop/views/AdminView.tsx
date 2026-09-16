import React, { Suspense, lazy, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Language, PrintJob, PrintStatus, ShopSettings, DiscountRule, PaperType } from "../types";
import { TRANSLATIONS } from "../constants";
import { storageService } from "../services/storageService";
import { toast } from "../components/ui/use-toast";
import { Toaster } from "../components/ui/toaster";
import PreviewModal from "../components/preview/PreviewModal";
import LanguageToggle from "../components/LanguageToggle";
import InventorySection from "../components/InventorySection";
import { AdminProvider } from "./admin/AdminContext";
import GmailPanel from "./admin/gmail/GmailPanel";
import ReviewQueuePanel from "./admin/review/ReviewQueuePanel";
import SettingsPanel from "./admin/settings/SettingsPanel";
import JobsPanel from "./admin/jobs/JobsPanel";
import { useAdminJobs } from "./admin/jobs/useAdminJobs";
// The studio tools carry pdf-lib/pdf.js and heavy canvas code. Most dashboard
// sessions never open them, so they load on first use rather than with the
// admin bundle.
const CardIDTool = lazy(() => import("./CardIDTool"));
const PDFJobManager = lazy(() => import("./PDFJobManager"));
const PhotoBatchTool = lazy(() => import("./PhotoBatchTool"));

const TabFallback: React.FC = () => (
  <div className="flex items-center justify-center py-16" role="status" aria-live="polite">
    <div className="w-7 h-7 rounded-full border-2 border-indigo-200 border-t-indigo-600 animate-spin dark:border-indigo-900 dark:border-t-indigo-400" />
  </div>
);
import { openAdminEventSource } from "../utils/adminEvents";
import { Icon } from "../components/ui/icon";

interface AdminViewProps {
  lang: Language;
  onLogout: () => void;
  onSettingsUpdate: (settings: ShopSettings) => void;
  currentSettings: ShopSettings;
  darkMode?: boolean;
  themeMode?: "light" | "dark" | "system";
  onToggleDarkMode?: () => void;
  onToggleLang?: (lang: Language) => void;
}

const AdminViewInner: React.FC<AdminViewProps> = ({
  lang,
  onLogout: _onLogout,
  onSettingsUpdate: _onSettingsUpdate,
  currentSettings,
  darkMode: _darkMode = false,
  themeMode = "system",
  onToggleDarkMode,
  onToggleLang,
}) => {
  // Safe translation function
  const t = (key: string) => {
    if (!TRANSLATIONS[key]) {
      console.warn(`Missing translation key: ${key}`);
      return key;
    }
    return TRANSLATIONS[key][lang] || TRANSLATIONS[key]["en"] || key;
  };

  const isRtl = lang === "ar";

  const [searchParams, setSearchParams] = useSearchParams();
  const validTabs = ["jobs", "settings", "gmail", "review", "inventory", "studio-cards", "studio-pdf", "studio-photos"] as const;
  type AdminTab = (typeof validTabs)[number];
  const urlTab = searchParams.get("tab") as AdminTab | null;
  const activeTab: AdminTab = urlTab && validTabs.includes(urlTab) ? urlTab : "jobs";
  const setActiveTab = (next: AdminTab) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "jobs") p.delete("tab");
        else p.set("tab", next);
        return p;
      },
      { replace: true },
    );
  };

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [discountRules, setDiscountRules] = useState<DiscountRule[]>([]);
  const [previewJob, setPreviewJob] = useState<PrintJob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Paper types are owned by SettingsPanel's draft; the rest of the dashboard
  // reads the *saved* value off currentSettings.
  const paperTypes: PaperType[] =
    currentSettings.paperTypes && currentSettings.paperTypes.length > 0
      ? currentSettings.paperTypes
      : [
          { id: "normal", name: "Normal", nameAr: "عادي", colorPerPage: currentSettings.pricing?.colorPerPage || 30.0, blackWhitePerPage: currentSettings.pricing?.blackWhitePerPage || 15.0 },
          { id: "glossy", name: "Glossy", nameAr: "لامع", colorPerPage: currentSettings.pricing?.glossyPerPage || 50.0, blackWhitePerPage: currentSettings.pricing?.glossyPerPage || 50.0 },
          { id: "cardboard", name: "Cardboard", nameAr: "ورق مقوى", colorPerPage: currentSettings.pricing?.cardboardPerPage || 40.0, blackWhitePerPage: currentSettings.pricing?.cardboardPerPage || 40.0 },
        ];

  const loadLowStockCount = async () => {
    try {
      const { lowStockCount: count } = await storageService.getInventory();
      setLowStockCount(count);
    } catch (err) {
      console.error("Failed to load low stock count:", err);
    }
  };

  const loadDiscountRules = async () => {
    try {
      setDiscountRules(await storageService.getDiscountRules());
    } catch (err) {
      console.error("Failed to load discount rules:", err);
    }
  };

  const jobs = useAdminJobs({ currentSettings, onLowStockRefresh: loadLowStockCount });

  const closePreview = () => {
    setPreviewJob(null);
    setPreviewUrl((prev) => {
      if (prev && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const handlePreview = async (job: PrintJob) => {
    const url = await storageService.getAdminFileUrl(job.id);
    if (url) {
      setPreviewJob(job);
      setPreviewUrl(url);
    } else {
      toast({
        title: isRtl ? "تعذّر فتح الملف" : "Could not open the file",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    loadDiscountRules();
    loadLowStockCount();
    // Persistent new-email toast — fires on any tab; GmailPanel owns the list.
    const es = openAdminEventSource();
    es.addEventListener("gmail-new", (e) => {
      try {
        const data = JSON.parse(e.data);
        if ((data.new || 0) > 0) {
          toast({ title: `${data.new} ${isRtl ? "بريد جديد" : "new email(s)"} ${isRtl ? "وصل" : "received"}`, variant: "success" });
          new Audio("/notification.mp3").play().catch(() => {});
        }
      } catch { /* ignored */ }
    });
    es.onerror = () => {};
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navItems: { id: AdminTab | "dashboard"; label: string; icon: string; badge?: number }[] = [
    { id: "dashboard", label: isRtl ? "لوحة المعلومات" : "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
    { id: "review", label: isRtl ? "مراجعة الطلبات" : "Job Review", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", badge: jobs.reviewJobs.length },
    { id: "inventory", label: isRtl ? "المخزون" : "Inventory", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", badge: lowStockCount },
    { id: "settings", label: t("settings"), icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
    { id: "gmail", label: isRtl ? "البريد الإلكتروني" : "Email", icon: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
  ];

  // Print Studio tools live on the dashboard now — no separate studio page.
  const studioNavItems = [
    { id: "studio-cards", label: t("cardsTab"), icon: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" },
    { id: "studio-pdf", label: t("pdfTab"), icon: "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" },
    { id: "studio-photos", label: t("photosTab"), icon: "M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" },
  ] as const;

  const activeNav = activeTab === "gmail" ? "gmail" : activeTab === "settings" ? "settings" : activeTab === "review" ? "review" : activeTab === "inventory" ? "inventory" : activeTab.startsWith("studio-") ? activeTab : "dashboard";

  return (
    <div className="flex h-screen overflow-hidden bg-[#F8FAFC] dark:bg-gray-950">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label={isRtl ? "إغلاق القائمة" : "Close menu"}
          className="fixed inset-0 z-40 bg-black/40 md:hidden cursor-default"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-50 w-[220px] flex-shrink-0 flex flex-col bg-gray-50 dark:bg-[#111] border-r border-border transition-transform duration-250 ease md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        } ${isRtl ? "font-['IBMPlexArabic']" : ""}`}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-5">
          <div className="w-9 h-9 bg-indigo-600 rounded-lg flex items-center justify-center text-white overflow-hidden shadow-sm flex-shrink-0">
            <Icon name="print" className="w-5 h-5" />
          </div>
          <span dir="auto" className="text-base font-bold tracking-tight text-foreground truncate">
            {currentSettings.shopName || TRANSLATIONS.appTitle[lang]}
          </span>
        </div>

        {/* Section: MAIN */}
        <div className="px-4 pt-6 pb-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {isRtl ? "رئيسي" : "MAIN"}
          </span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-2 space-y-0.5">
          {navItems.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (item.id !== "dashboard") setActiveTab(item.id);
                  else setActiveTab("jobs");
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 ease ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/20"
                    : "text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
                }`}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d={item.icon} />
                </svg>
                <span className="flex-1 text-start">{item.label}</span>
                {!!item.badge && (
                  <span className={`text-xs font-bold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${isActive ? "bg-white/20 text-white" : "bg-red-500 text-white"}`}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Section: STUDIO */}
        <div className="px-4 pt-2 pb-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            {isRtl ? "الاستوديو" : "STUDIO"}
          </span>
        </div>

        <nav className="px-3 pb-2 space-y-0.5">
          {studioNavItems.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { setActiveTab(item.id); setSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150 ease ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-sm shadow-indigo-500/20"
                    : "text-gray-600 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/[0.06]"
                }`}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                  <path d={item.icon} />
                </svg>
                <span className="flex-1 text-start">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Dark mode + Language toggles */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button
            onClick={onToggleDarkMode}
            className="p-2 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06] transition-colors"
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
              <Icon name="sun" className="w-4 h-4" />
            ) : themeMode === "dark" ? (
              <Icon name="moon" className="w-4 h-4" />
            ) : (
              <Icon name="monitor" className="w-4 h-4" />
            )}
          </button>
          {onToggleLang && <LanguageToggle currentLang={lang} onToggle={onToggleLang} />}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header with hamburger */}
        <div className="md:hidden flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
          <button
            onClick={() => setSidebarOpen(true)}
              aria-label={isRtl ? "فتح القائمة" : "Open menu"}
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-black/5 dark:hover:bg-white/[0.06]"
          >
            <Icon name="menu" className="w-5 h-5" />
          </button>
          <span className="text-sm font-semibold text-foreground">
            {currentSettings.shopName || TRANSLATIONS.appTitle[lang]}
          </span>
          <div className="w-5" />
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto bg-card">
          <div className="p-8 text-foreground">
      <div className="min-h-0">
        <Suspense fallback={<TabFallback />}>
        {activeTab === "jobs" ? (
          <JobsPanel jobs={jobs} paperTypes={paperTypes} discountRules={discountRules} onPreview={handlePreview} />
        ) : activeTab === "review" ? (
          <ReviewQueuePanel reviewJobs={jobs.reviewJobs} onRefresh={jobs.loadJobs} onPreview={handlePreview} />
        ) : activeTab === "gmail" ? (
          <GmailPanel paperTypes={paperTypes} onJobsImported={jobs.loadJobs} />
        ) : activeTab === "inventory" ? (
          <InventorySection
            lang={lang}
            paperTypes={paperTypes}
            onLowStockCountChange={setLowStockCount}
          />
        ) : activeTab === "studio-cards" ? (
          <CardIDTool />
        ) : activeTab === "studio-pdf" ? (
          <PDFJobManager />
        ) : activeTab === "studio-photos" ? (
          <PhotoBatchTool />
        ) : (
          <SettingsPanel
            discountRules={discountRules}
            onRulesChanged={loadDiscountRules}
            onManageInventory={() => setActiveTab("inventory")}
            jobStats={{
              pending: jobs.groups.reduce((acc, g) => acc + g.jobs.filter((j) => j.status === PrintStatus.PENDING).length, 0),
              ready: jobs.groups.reduce((acc, g) => acc + g.jobs.filter((j) => j.status === PrintStatus.READY).length, 0),
              printed: jobs.groups.reduce((acc, g) => acc + g.jobs.filter((j) => j.status === PrintStatus.PRINTED).length, 0),
              customers: jobs.groups.length,
            }}
          />
        )}
        </Suspense>
      </div>

      {/* Toaster */}
      <Toaster />


      <PreviewModal
        open={previewJob !== null}
        onClose={closePreview}
        url={previewUrl}
        fileName={previewJob?.fileName ?? ""}
        fileType={previewJob?.fileType}
        fileSize={previewJob?.fileSize}
      />

          </div>
        </div>
      </div>
    </div>
  );
};

const AdminView: React.FC<AdminViewProps> = (props) => (
  <AdminProvider
    lang={props.lang}
    darkMode={props.darkMode ?? false}
    themeMode={props.themeMode ?? "system"}
    onToggleDarkMode={props.onToggleDarkMode}
    onToggleLang={props.onToggleLang}
    settings={props.currentSettings}
    onSettingsUpdate={props.onSettingsUpdate}
  >
    <AdminViewInner {...props} />
  </AdminProvider>
);

export default AdminView;
