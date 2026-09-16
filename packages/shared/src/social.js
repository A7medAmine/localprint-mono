// The shop's social links: one small, closed set of platforms, normalized the
// same way on the desktop server, the cloud server and the browser.
//
// Each field holds a LINK, not a username — the operator pastes the page's own
// address straight out of their browser, which is the one thing that is always
// right. Usernames are not accepted: the same handle means a different URL on
// every platform, and a guessed one sends customers to a page that isn't the
// shop's.
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
 */

/** @type {SocialPlatform[]} */
export const SOCIAL_PLATFORMS = [
  {
    id: 'facebook',
    label: 'Facebook',
    labelAr: 'فيسبوك',
    placeholder: 'https://facebook.com/yourshop',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    labelAr: 'إنستغرام',
    placeholder: 'https://instagram.com/yourshop',
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    labelAr: 'تيك توك',
    placeholder: 'https://tiktok.com/@yourshop',
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    labelAr: 'واتساب',
    placeholder: 'https://wa.me/213555001122',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    labelAr: 'تيليغرام',
    placeholder: 'https://t.me/yourshop',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    labelAr: 'يوتيوب',
    placeholder: 'https://youtube.com/@yourshop',
  },
  {
    id: 'website',
    label: 'Website',
    labelAr: 'الموقع الإلكتروني',
    placeholder: 'https://yourshop.dz',
  },
];

export const SOCIAL_PLATFORM_IDS = SOCIAL_PLATFORMS.map((p) => p.id);

const PLATFORM_IDS = new Set(SOCIAL_PLATFORMS.map((p) => p.id));

const MAX_SOCIAL_VALUE_LENGTH = 300;

/**
 * One operator-entered link into a public, clickable https URL — or null when
 * it is not a link at all.
 *
 * A missing scheme is the one thing filled in for the operator ("facebook.com/
 * x" works); a bare username is not, because there is nothing to fill in.
 *
 * @param {string} platformId
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeSocialUrl(platformId, raw) {
  if (!PLATFORM_IDS.has(platformId)) return null;
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text || text.length > MAX_SOCIAL_VALUE_LENGTH || /\s/.test(text)) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(text);
  // No scheme and no dot in the host means this is a handle, not a link.
  if (!hasScheme && !text.includes('.')) return null;

  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
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
