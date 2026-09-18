// Typed, fail-soft access to everything the apps keep in localStorage.
//
// Reading storage throws in a private window and returns stale JSON after a
// schema change, so every accessor here swallows the failure and answers with
// the caller's fallback. Call sites therefore never need their own try/catch,
// and the set of keys in use is visible in one place instead of being spelled
// out as a string literal in twenty components.

export const PREF_KEYS = {
  language: "ps_language",
  theme: "ps_theme",
  /** Pre-"system" theme flag; read once to migrate, then removed. */
  legacyDarkMode: "ps_dark_mode",
  adminToken: "ps_admin_token",
  jobsDensity: "ps_jobs_density",
  onboardingDone: "ps_onboarding_done",
  lastShopSlug: "ps_last_shop_slug",
  deviceId: "lp_device_id",
  myUploadIds: "my_upload_ids",
  myUploadTokens: "my_upload_tokens",
  imageFilterPresets: "ps_image_filter_presets",
  credentialCardPaperSize: "ps_credential_card_paper_size",
  /** "1" when Print Studio work should survive an app restart. */
  studioPersist: "ps_studio_persist",
} as const;

export type PrefKey = keyof typeof PREF_KEYS;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Private mode / blocked site data.
    return null;
  }
}

/** Raw string value, or `fallback` when unset or unreadable. */
export function readPref(key: PrefKey): string | null;
export function readPref(key: PrefKey, fallback: string): string;
export function readPref(key: PrefKey, fallback: string | null = null): string | null {
  try {
    const value = storage()?.getItem(PREF_KEYS[key]);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: PrefKey, value: string): void {
  try {
    storage()?.setItem(PREF_KEYS[key], value);
  } catch {
    // Quota or blocked storage — the preference just does not persist.
  }
}

export function clearPref(key: PrefKey): void {
  try {
    storage()?.removeItem(PREF_KEYS[key]);
  } catch {
    /* nothing to clean up */
  }
}

/** Value constrained to a known set — anything else falls back. */
export function readEnumPref<T extends string>(
  key: PrefKey,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = readPref(key);
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

/** JSON value, or `fallback` when unset, unreadable or malformed. */
export function readJsonPref<T>(key: PrefKey, fallback: T): T {
  const raw = readPref(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonPref(key: PrefKey, value: unknown): void {
  try {
    writePref(key, JSON.stringify(value));
  } catch {
    /* value not serializable — nothing to persist */
  }
}
