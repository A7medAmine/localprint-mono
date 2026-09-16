// The shop's social links: one small, closed set of platforms, normalized the
// same way on the desktop server, the cloud server and the browser.
//
// Everything here is written by a shop operator and rendered as an `href` on a
// public page, so normalization is also the security boundary: only http(s)
// URLs survive it. A pasted "javascript:..." or "data:..." is dropped, never
// stored and never linked.

/**
 * @typedef {Object} SocialPlatform
 * @property {string} id
 * @property {string} label
 * @property {string} labelAr
 * @property {string} placeholder
 * @property {(handle: string) => string} fromHandle
 */

/** Strip the decorations operators paste around a handle ("@name", "/name/"). */
const cleanHandle = (value) => value.replace(/^@+/, '').replace(/^\/+|\/+$/g, '').trim();

/** @type {SocialPlatform[]} */
export const SOCIAL_PLATFORMS = [
  {
    id: 'facebook',
    label: 'Facebook',
    labelAr: 'فيسبوك',
    placeholder: 'facebook.com/yourshop',
    fromHandle: (handle) => `https://facebook.com/${handle}`,
  },
  {
    id: 'instagram',
    label: 'Instagram',
    labelAr: 'إنستغرام',
    placeholder: '@yourshop',
    fromHandle: (handle) => `https://instagram.com/${handle}`,
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    labelAr: 'تيك توك',
    placeholder: '@yourshop',
    fromHandle: (handle) => `https://tiktok.com/@${handle}`,
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    labelAr: 'واتساب',
    placeholder: '+213 555 00 00 00',
    // A bare phone number is what operators actually have; wa.me wants digits
    // only, no "+", spaces or dashes.
    fromHandle: (handle) => `https://wa.me/${handle.replace(/\D/g, '')}`,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    labelAr: 'تيليغرام',
    placeholder: '@yourshop',
    fromHandle: (handle) => `https://t.me/${handle}`,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    labelAr: 'يوتيوب',
    placeholder: '@yourshop',
    fromHandle: (handle) => `https://youtube.com/@${handle}`,
  },
  {
    id: 'website',
    label: 'Website',
    labelAr: 'الموقع الإلكتروني',
    placeholder: 'yourshop.com',
    fromHandle: (handle) => `https://${handle}`,
  },
];

export const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

const PLATFORM_BY_ID = new Map(SOCIAL_PLATFORMS.map((p) => [p.id, p]));

const MAX_SOCIAL_VALUE_LENGTH = 300;

/**
 * One operator-entered value into a public, clickable https URL — or null when
 * it cannot become one.
 *
 * @param {string} platformId
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeSocialUrl(platformId, raw) {
  const platform = PLATFORM_BY_ID.get(platformId);
  if (!platform) return null;
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text || text.length > MAX_SOCIAL_VALUE_LENGTH) return null;

  // WhatsApp is the one field people fill with a phone number rather than a
  // link, so a digits-only value is resolved before any URL parsing.
  if (platform.id === 'whatsapp' && /^\+?[\d\s().-]{6,}$/.test(text)) {
    const digits = text.replace(/\D/g, '');
    return digits.length >= 6 ? `https://wa.me/${digits}` : null;
  }

  const looksLikeUrl = /^[a-z][a-z\d+.-]*:/i.test(text) || text.includes('/') || text.includes('.');
  if (!looksLikeUrl) {
    const handle = cleanHandle(text);
    if (!handle || /\s/.test(handle)) return null;
    return platform.fromHandle(handle);
  }

  const withScheme = /^https?:\/\//i.test(text)
    ? text
    : /^[a-z][a-z\d+.-]*:/i.test(text)
      ? text // some other scheme — parsed below, then rejected
      : `https://${text}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // The allowlist. Anything else (javascript:, data:, file:, ...) is dropped.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname || !url.hostname.includes('.')) return null;
  url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

/**
 * A whole social-links bag, normalized. Unknown keys are dropped, empty values
 * are dropped, and the result is always a plain object (possibly empty), so
 * callers can store it without another null check.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeSocialLinks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const platform of SOCIAL_PLATFORMS) {
    const url = normalizeSocialUrl(platform.id, /** @type {any} */ (raw)[platform.id]);
    if (url) out[platform.id] = url;
  }
  return out;
}

/** The platforms a shop actually filled, in the order they are displayed. */
export function activeSocialLinks(links) {
  if (!links || typeof links !== 'object') return [];
  return SOCIAL_PLATFORMS
    .filter((platform) => typeof links[platform.id] === 'string' && links[platform.id].trim())
    .map((platform) => ({ platform, url: links[platform.id] }));
}

/** Longest a shop description may be, enforced on both servers and in the UI. */
export const MAX_DESCRIPTION_LENGTH = 500;

/** @param {unknown} raw @returns {string} */
export function normalizeDescription(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_DESCRIPTION_LENGTH);
}
