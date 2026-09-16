// What a settings object is allowed to look like on the way out of the server,
// plus the parsing of the one cloud link an operator is given.

// Keys the UNAUTHENTICATED public upload page is allowed to read. Anything not
// listed here (secrets, cloud credentials, internal state) never leaves the
// server on the public endpoint.
export const PUBLIC_SETTINGS_KEYS = new Set([
  "shopName", "logoUrl", "pricing", "discounts",
  "phoneNumbers", "email", "address", "workingHours", "returnPolicy",
  "currency",
  // Public storefront link — the customer share sheet builds its QR from these.
  // Both are already public information (the site URL and its slug).
  "cloudSyncUrl", "cloudShopSlug",
]);

// Keys that must NEVER be serialized into any HTTP response, even for admins.
export const SECRET_SETTINGS_KEYS = new Set([
  "gmailTokens", "gmailToken",
]);

// Operators hand out ONE link per store: https://cloud.example.com/s/<slug>
// (with or without a trailing /upload and query). The desktop app talks to the
// platform root, so split that link into the API base URL and the storefront
// slug. A bare root URL is accepted too — the slug then arrives on the first
// settings sync.
export function parseCloudLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return { baseUrl: '', slug: '' };
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { baseUrl: text.replace(/\/+$/, ''), slug: '' };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.indexOf('s');
  let slug = '';
  if (marker !== -1 && segments[marker + 1]) {
    slug = decodeURIComponent(segments[marker + 1]);
    segments.length = marker; // everything before /s/<slug> stays in the base
  }
  const basePath = segments.length ? `/${segments.join('/')}` : '';
  return { baseUrl: `${url.origin}${basePath}`, slug };
}

export function pickPublicSettings(settings) {
  const out = {};
  for (const key of PUBLIC_SETTINGS_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key];
  }
  return out;
}

export function stripSecretSettings(settings) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (SECRET_SETTINGS_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}
