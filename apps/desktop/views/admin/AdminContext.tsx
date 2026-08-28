import React, { createContext, useContext, useMemo } from "react";
import { Language, ShopSettings } from "../../types";
import { TRANSLATIONS } from "../../constants";

/**
 * Shared context for the admin dashboard. Carries the handful of values that
 * nearly every panel needs (language, translations, theme, shop settings) so
 * they don't have to be threaded through as props on every extracted component.
 */
interface AdminContextValue {
  lang: Language;
  isRtl: boolean;
  t: (key: string) => string;
  darkMode: boolean;
  themeMode: "light" | "dark" | "system";
  onToggleDarkMode?: () => void;
  onToggleLang?: (lang: Language) => void;
  settings: ShopSettings;
  onSettingsUpdate: (settings: ShopSettings) => void;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export const makeT = (lang: Language) => (key: string) => {
  if (!TRANSLATIONS[key]) {
    console.warn(`Missing translation key: ${key}`);
    return key;
  }
  return TRANSLATIONS[key][lang] || TRANSLATIONS[key]["en"] || key;
};

interface AdminProviderProps {
  lang: Language;
  darkMode: boolean;
  themeMode: "light" | "dark" | "system";
  onToggleDarkMode?: () => void;
  onToggleLang?: (lang: Language) => void;
  settings: ShopSettings;
  onSettingsUpdate: (settings: ShopSettings) => void;
  children: React.ReactNode;
}

export const AdminProvider: React.FC<AdminProviderProps> = ({
  lang,
  darkMode,
  themeMode,
  onToggleDarkMode,
  onToggleLang,
  settings,
  onSettingsUpdate,
  children,
}) => {
  const value = useMemo<AdminContextValue>(
    () => ({
      lang,
      isRtl: lang === "ar",
      t: makeT(lang),
      darkMode,
      themeMode,
      onToggleDarkMode,
      onToggleLang,
      settings,
      onSettingsUpdate,
    }),
    [lang, darkMode, themeMode, onToggleDarkMode, onToggleLang, settings, onSettingsUpdate],
  );
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
};

export const useAdmin = (): AdminContextValue => {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin must be used within an AdminProvider");
  return ctx;
};
