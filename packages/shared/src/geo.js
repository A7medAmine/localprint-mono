/**
 * Shop location primitives: coordinate validation, map-link parsing and
 * great-circle distance. Dependency-free (no fs, no network, no DOM) so the
 * two Node servers, the Electron renderer and the browser bundle all import
 * the same rules. Server-side code loads this via the "@atba3li/shared/geo"
 * subpath, which resolves to this real .js file — plain Node can't import the
 * package's TypeScript index entry.
 *
 * Following a short link (maps.app.goo.gl) needs an HTTP request, so that part
 * lives in the desktop server; everything here is pure.
 */

// Where a stored location came from. Kept on the record because it tells an
// operator how much to trust the pin: a dragged pin is deliberate, a GPS fix
// carries an accuracy radius, a parsed link is only as good as the listing.
export const LOCATION_SOURCES = ['map', 'gps', 'url', 'manual'];

// Six decimals is ~11cm at the equator — far finer than any shopfront needs,
// and it keeps the stored JSON short.
const COORD_PRECISION = 6;

const round = (n) => Number(n.toFixed(COORD_PRECISION));

/**
 * Coerce anything into a finite number, rejecting the values `Number()` is too
 * generous about ("", null, [], whitespace) which would all become 0 — a valid
 * latitude, and one that would silently drop a shop into the Gulf of Guinea.
 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export const isValidLatitude = (value) => {
  const n = toFiniteNumber(value);
  return n !== null && n >= -90 && n <= 90;
};

export const isValidLongitude = (value) => {
  const n = toFiniteNumber(value);
  return n !== null && n >= -180 && n <= 180;
};

/**
 * Normalize an untrusted location object into the shape that gets stored, or
 * null if it carries no usable coordinate pair. Both servers run every inbound
 * location through this — the desktop one because an admin can post anything,
 * the cloud one because a desktop's sync payload is not trusted either.
 *
 * Unknown keys are dropped rather than passed through: this object is served
 * to the public directory, so it must never become a place to smuggle data.
 */
export function normalizeLocation(input) {
  if (!input || typeof input !== 'object') return null;
  if (!isValidLatitude(input.lat) || !isValidLongitude(input.lng)) return null;

  const accuracy = toFiniteNumber(input.accuracy);
  const source = LOCATION_SOURCES.includes(input.source) ? input.source : 'manual';
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 200) : '';
  const updatedAt = typeof input.updatedAt === 'string' && !Number.isNaN(Date.parse(input.updatedAt))
    ? input.updatedAt
    : new Date().toISOString();

  return {
    lat: round(toFiniteNumber(input.lat)),
    lng: round(toFiniteNumber(input.lng)),
    // A negative or absurd radius is meaningless; drop it rather than store it.
    ...(accuracy !== null && accuracy >= 0 && accuracy <= 100000
      ? { accuracy: Math.round(accuracy) }
      : {}),
    source,
    ...(label ? { label } : {}),
    updatedAt,
  };
}

/**
 * Parse a "lat, lng" pair as a human types it. Accepts a comma or whitespace
 * separator and the Arabic decimal separator, since the settings screen is
 * used in both languages.
 */
export function parseCoordinatePair(raw) {
  const text = String(raw || '').replace(/٫/g, '.').trim();
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const [, lat, lng] = match;
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) return null;
  return { lat: round(Number(lat)), lng: round(Number(lng)) };
}

// Hosts whose links are short redirects — they carry no coordinates at all, so
// the caller has to resolve them over the network before parsing again.
const SHORT_LINK_HOSTS = [
  'maps.app.goo.gl',
  'goo.gl',
  'g.co',
  'maps.google.com/maps?cid=', // a place id, not a position
  'w.waze.com',
];

/** True when a URL can only be turned into coordinates by following it. */
export function isShortMapLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co|w\.waze\.com)\//i.test(text)) return true;
  return SHORT_LINK_HOSTS.some((host) => host.includes('?') && text.includes(host));
}

/**
 * Pull a coordinate pair out of a map URL pasted from Google Maps, Waze,
 * OpenStreetMap, Apple Maps or Bing. Returns null when the link carries no
 * position (a short link, or a search for a name), which the caller
 * distinguishes with isShortMapLink().
 *
 * Ordered most-specific first: a Google place URL contains both the map
 * viewport (@lat,lng — where the camera is) and the place itself
 * (!3d…!4d… — where the pin is). The pin wins.
 */
export function parseMapUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // OpenStreetMap spells the pin as separate query parameters, alongside a
  // #map= viewport. Same rule as Google: the pin wins over the camera, so this
  // runs before the pattern list.
  const osmLat = text.match(/[?&]mlat=(-?\d+(?:\.\d+)?)/);
  const osmLng = text.match(/[?&]mlon=(-?\d+(?:\.\d+)?)/);
  if (osmLat && osmLng && isValidLatitude(osmLat[1]) && isValidLongitude(osmLng[1])) {
    return { lat: round(Number(osmLat[1])), lng: round(Number(osmLng[1])) };
  }

  const patterns = [
    // Google place pin: …!3d36.7538!4d3.0588
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    // Google viewport: /@36.7538,3.0588,17z
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    // Google / Apple query: ?q=36.7538,3.0588 or ?ll= or ?daddr= or ?sll=
    /[?&](?:q|ll|sll|daddr|saddr|destination|center|mlat)=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i,
    // Waze: ?ll=36.7538,3.0588 (covered above) and /ul?ll=…&navigate=yes
    /[?&]latlng=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
    // OpenStreetMap: #map=17/36.7538/3.0588
    /#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/,
    // Bare "36.7538,3.0588" pasted instead of a link
    /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const [, lat, lng] = match;
    if (isValidLatitude(lat) && isValidLongitude(lng)) {
      return { lat: round(Number(lat)), lng: round(Number(lng)) };
    }
  }

  return null;
}

const EARTH_RADIUS_KM = 6371;
const toRadians = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres. This is a straight line, not a driving
 * route — the UI labels it "distance", never "time", because the two differ a
 * lot in a city.
 */
export function distanceKm(from, to) {
  if (!from || !to) return null;
  const lat1 = toFiniteNumber(from.lat);
  const lng1 = toFiniteNumber(from.lng);
  const lat2 = toFiniteNumber(to.lat);
  const lng2 = toFiniteNumber(to.lng);
  if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;

  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "850 m" under a kilometre, "2.4 km" under ten, "37 km" above. */
export function formatDistance(km, locale = 'en') {
  if (km === null || !Number.isFinite(km)) return '';
  const ar = locale === 'ar';
  if (km < 1) return `${Math.round(km * 1000)} ${ar ? 'م' : 'm'}`;
  const unit = ar ? 'كم' : 'km';
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} ${unit}`;
}

/**
 * Sort shops by distance from a point, keeping the ones without a location.
 * A shop that never set a pin still has to be reachable from the directory,
 * so it sinks to the bottom in its original order instead of disappearing.
 */
export function sortByDistance(shops, origin) {
  const withDistance = (shops || []).map((shop, index) => ({
    shop,
    index,
    km: origin ? distanceKm(origin, shop?.location) : null,
  }));
  withDistance.sort((a, b) => {
    if (a.km === null && b.km === null) return a.index - b.index;
    if (a.km === null) return 1;
    if (b.km === null) return -1;
    return a.km - b.km;
  });
  return withDistance.map(({ shop, km }) => ({ ...shop, distanceKm: km }));
}

/**
 * Turn-by-turn link. We render OpenStreetMap tiles but hand navigation to
 * Google, which has by far the better road data for Algeria.
 */
export function directionsUrl(location) {
  const normalized = normalizeLocation(location);
  if (!normalized) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${normalized.lat},${normalized.lng}`;
}
