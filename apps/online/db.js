import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { WebSocket } from 'ws';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { checkEnv } from './checkEnv.js';
import { makeTokenCache, isRejectedTokenError } from './utils/authCache.js';
import { toApiOrder } from './utils/orderMapping.js';

// db.js is the first module to require real env values. ESM evaluates imported
// modules before the importer's body, so this is the earliest reliable point
// to fail with an actionable list instead of a raw throw.
checkEnv();

// Provide native WebSocket for environments that lack it (Alpine Node < 22)
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: { transport: WebSocket },
});

/**
 * Shop Helpers
 */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'shop';

export const getShopBySlug = async (slug) => {
  const { data, error } = await supabase.from('shops').select('*').eq('slug', slug).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
};

export const getShopByTokenHash = async (tokenHash) => {
  const { data, error } = await supabase.from('shops').select('*').eq('token_hash', tokenHash).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
};

export const createShop = async (name) => {
  const baseSlug = slugify(name);
  let slug = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getShopBySlug(slug);
    if (!existing) break;
    slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
  }

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);

  const { error } = await supabase.from('shops').insert({
    id,
    slug,
    name,
    token_hash: tokenHash,
  });
  if (error) throw error;

  return { id, slug, name, token };
};

// Platform-admin helpers ────────────────────────────────────────────────
export const listShops = async () => {
  const { data, error } = await supabase
    .from('shops')
    .select('id, slug, name, is_active, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
};

// The public profile fields the directory shows next to each shop. Anything
// outside this list stays private — the `settings` bag also holds pricing,
// tokens and internal keys like `_logo_filename`.
const PUBLIC_DIRECTORY_SETTINGS = ['logoUrl', 'phoneNumbers', 'email', 'address', 'workingHours'];

// Public storefront directory — what the platform root lists when a customer
// lands without a shop slug. Active shops only, and no ids/tokens/timestamps.
// Each shop carries its public profile (logo, phones, email, address, hours) so
// the directory can show a real storefront card instead of a bare name; the
// settings for every shop come back in one query rather than one per shop.
export const listPublicShops = async () => {
  const { data, error } = await supabase
    .from('shops')
    .select('id, slug, name, is_active')
    .order('name', { ascending: true });
  if (error) throw error;

  const active = (data || []).filter((s) => s.is_active !== false);
  if (active.length === 0) return [];

  const { data: rows, error: settingsError } = await supabase
    .from('settings')
    .select('shop_id, key, value')
    .in('shop_id', active.map((s) => s.id))
    .in('key', PUBLIC_DIRECTORY_SETTINGS);
  // A settings failure must not take the directory down — a card with just a
  // name still gets the customer to the right shop.
  if (settingsError) console.error('listPublicShops settings:', settingsError);

  const byShop = new Map();
  (rows || []).forEach((row) => {
    let value = row.value;
    try { value = JSON.parse(row.value); } catch { /* plain string */ }
    if (!byShop.has(row.shop_id)) byShop.set(row.shop_id, {});
    byShop.get(row.shop_id)[row.key] = value;
  });

  return active.map(({ id, slug, name }) => {
    const profile = byShop.get(id) || {};
    return {
      slug,
      name,
      logoUrl: profile.logoUrl || null,
      phoneNumbers: Array.isArray(profile.phoneNumbers) ? profile.phoneNumbers : [],
      email: profile.email || null,
      address: profile.address || null,
      workingHours: profile.workingHours || null,
    };
  });
};

// Platform-wide + per-shop stats for the admin dashboard. Orders are fetched
// in full and aggregated in JS — Supabase's JS client has no cross-row SUM,
// and order volume here is small enough that this stays cheap.
export const getPlatformStats = async () => {
  const [{ data: shops, error: shopsErr }, { data: orders, error: ordersErr }] = await Promise.all([
    supabase.from('shops').select('id, slug, name, is_active'),
    supabase.from('orders').select('shop_id, pagecount, total_price, copies, uploaddate'),
  ]);
  if (shopsErr) throw shopsErr;
  if (ordersErr) throw ordersErr;

  const byShop = new Map((shops || []).map((s) => [s.id, {
    id: s.id, slug: s.slug, name: s.name, isActive: s.is_active !== false,
    orderCount: 0, totalPages: 0,
  }]));

  let totalOrders = 0, totalPages = 0, totalRevenue = 0, ordersLast30d = 0;
  const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const o of orders || []) {
    const pages = (Number(o.pagecount) || 0) * (Number(o.copies) || 1);
    const revenue = Number(o.total_price) || 0;
    totalOrders += 1;
    totalPages += pages;
    totalRevenue += revenue;
    if (o.uploaddate && new Date(o.uploaddate).getTime() >= since30) ordersLast30d += 1;
    const s = byShop.get(o.shop_id);
    if (s) {
      s.orderCount += 1;
      s.totalPages += pages;
    }
  }

  return {
    totalShops: (shops || []).length,
    activeShops: (shops || []).filter((s) => s.is_active !== false).length,
    totalOrders,
    totalPages,
    totalRevenue,
    ordersLast30d,
    shops: [...byShop.values()].sort((a, b) => b.orderCount - a.orderCount),
  };
};

export const rotateShopToken = async (id) => {
  const token = randomBytes(32).toString('hex');
  const { data, error } = await supabase
    .from('shops')
    .update({ token_hash: hashToken(token) })
    .eq('id', id)
    .select('id, slug, name')
    .single();
  if (error) throw error;
  if (!data) return null;
  return { ...data, token };
};

export const updateShop = async (id, { name, slug, is_active } = {}) => {
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (slug !== undefined) patch.slug = slugify(slug);
  if (is_active !== undefined) patch.is_active = !!is_active;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await supabase
    .from('shops')
    .update(patch)
    .eq('id', id)
    .select('id, slug, name, is_active')
    .single();
  if (error) throw error;
  return data;
};

/**
 * Customer Account Helpers (optional — guest uploads never touch these)
 */
// Raised when we cannot *determine* whether a token is valid — Supabase Auth
// unreachable, JWKS fetch failed, etc. Distinct from a token we successfully
// verified and rejected: callers must answer 503, never 401, on this.
export class AuthUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuthUnavailableError';
  }
}

const AUTH_TIMEOUT_MS = 5000;

// Supabase signs customer JWTs with asymmetric keys (ES256) published at the
// project's JWKS endpoint. Verifying locally means an authenticated request
// costs zero network round-trips: jose caches the key set in memory and only
// refetches when it sees an unknown `kid` (i.e. after a key rotation).
const JWKS = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`), {
  timeoutDuration: AUTH_TIMEOUT_MS,
  cooldownDuration: 30_000,
  cacheMaxAge: 10 * 60_000,
});

// Short-lived memo so bursts of requests carrying the same token (page load
// firing profile + orders together) don't re-verify repeatedly. TTL/eviction
// math lives in utils/authCache.js (tested with an injectable clock).
const tokenCache = makeTokenCache({ ttlMs: 60_000, maxSize: 1000 });

// Remote fallback, used only when local verification can't reach a verdict
// (e.g. a legacy HS256 project whose JWKS has no usable key).
//
// This deliberately calls the REST endpoint directly instead of
// supabase.auth.getUser(): auth-js has no timeout option, so a hung call runs
// to undici's 10s connect timeout, and its internal promise chain leaks the
// rejection to the console even when the caller has handled it. A plain fetch
// with AbortSignal actually tears the socket down and stays quiet.
const getUserRemote = async (token) => {
  let res;
  try {
    res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseKey },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthUnavailableError(`Supabase auth unreachable: ${err.message}`, { cause: err });
  }

  // 401/403 is a real verdict: the token is bad.
  if (res.status === 401 || res.status === 403) return null;
  // Anything else non-OK is Supabase failing, not the token being invalid.
  if (!res.ok) {
    throw new AuthUnavailableError(`Supabase auth returned ${res.status}`);
  }

  try {
    const user = await res.json();
    return user?.id ? user : null;
  } catch (err) {
    throw new AuthUnavailableError('Supabase auth returned malformed JSON', { cause: err });
  }
};

/**
 * Resolve a Supabase access token to a user.
 *
 * @returns the user, or `null` if the token is genuinely invalid/expired.
 * @throws {AuthUnavailableError} if validity could not be determined.
 */
export const getSupabaseUserFromToken = async (token) => {
  if (!token) return null;

  const cached = tokenCache.get(token);
  if (cached !== undefined) return cached;

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
    });
    const user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      app_metadata: payload.app_metadata,
      user_metadata: payload.user_metadata,
    };
    tokenCache.set(token, user, payload.exp);
    return user;
  } catch (err) {
    // A token we successfully evaluated and rejected — expired, bad signature,
    // wrong audience. This is a real 401.
    if (isRejectedTokenError(err, joseErrors)) {
      return null;
    }
    // Couldn't fetch/parse the key set, or the token is signed with a key this
    // endpoint doesn't publish (legacy HS256 projects) — ask Supabase directly.
    console.warn('⚠️  Local JWT verification inconclusive, falling back to Supabase:', err.message);
    const user = await getUserRemote(token);
    if (user) tokenCache.set(token, user);
    return user;
  }
};

const toCamelProfile = (row) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  email: row.email,
  defaultPaperTypeId: row.default_paper_type_id,
  defaultCopies: row.default_copies,
});

export const getProfile = async (userId) => {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
};

export const getProfileCamel = async (userId) => {
  const profile = await getProfile(userId);
  return profile ? toCamelProfile(profile) : null;
};

export const upsertProfile = async (userId, fields) => {
  const { error } = await supabase.from('profiles').upsert({ id: userId, ...fields }, { onConflict: 'id' });
  if (error) throw error;
  return getProfileCamel(userId);
};

// Customer's orders across all shops, newest first, with shop name/slug attached.
// No FK relationship is declared between orders.shop_id and shops.id, so this
// can't use PostgREST embedding — fetch orders then batch-lookup shops in JS,
// matching the rest of this file's style.
export const getCustomerOrders = async (userId) => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', userId)
    .order('uploaddate', { ascending: false });
  if (error) throw error;
  if (!orders || orders.length === 0) return [];

  const shopIds = [...new Set(orders.map(o => o.shop_id))];
  const { data: shops, error: shopsErr } = await supabase
    .from('shops')
    .select('id, name, slug')
    .in('id', shopIds);
  if (shopsErr) throw shopsErr;
  const shopById = Object.fromEntries((shops || []).map(s => [s.id, s]));

  return orders.map(order => {
    const shop = shopById[order.shop_id];
    const api = toApiOrder(order);
    // Customer-facing projection: their own order fields + the shop it went to.
    // Deliberately omits customerName/phoneNumber/notes/serverFileName/source.
    return {
      id: api.id,
      fileName: api.fileName,
      fileType: api.fileType,
      fileSize: api.fileSize,
      uploadDate: api.uploadDate,
      status: api.status,
      pageCount: api.pageCount,
      colorMode: api.colorMode,
      copies: api.copies,
      paperType: api.paperType,
      totalPrice: api.totalPrice,
      shopName: shop?.name || null,
      shopSlug: shop?.slug || null,
    };
  });
};

/**
 * Settings Helpers
 */
export const getSettings = async (shopId) => {
  const { data: rows, error } = await supabase.from('settings').select('*').eq('shop_id', shopId);
  if (error) throw error;
  const settings = {};
  (rows || []).forEach(row => {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  });
  return settings;
};

export const updateSetting = async (shopId, key, value) => {
  const serializedValue = typeof value === 'object' ? JSON.stringify(value) : value;
  const { error } = await supabase.from('settings').upsert(
    { shop_id: shopId, key, value: serializedValue },
    { onConflict: 'shop_id,key' }
  );
  if (error) throw error;
};

/**
 * Paper Types Helpers
 */
const toCamelPaperType = (row) => ({
  id: row.id,
  name: row.name,
  nameAr: row.namear,
  colorPerPage: row.colorperpage,
  blackWhitePerPage: row.blackwhiteperpage,
});

export const getPaperTypes = async (shopId) => {
  const { data, error } = await supabase.from('paper_types').select('*').eq('shop_id', shopId).order('sortorder', { ascending: true });
  if (error) throw error;
  return (data || []).map(toCamelPaperType);
};

export const replaceAllPaperTypes = async (shopId, types) => {
  const { error: delError } = await supabase.from('paper_types').delete().eq('shop_id', shopId);
  if (delError && delError.code !== 'PGRST116') throw delError;
  if (types.length === 0) return;
  const rows = types.map((pt, idx) => ({
    id: pt.id,
    shop_id: shopId,
    name: pt.name,
    namear: pt.nameAr || pt.name,
    colorperpage: pt.colorPerPage,
    blackwhiteperpage: pt.blackWhitePerPage,
    sortorder: idx,
  }));
  const { error } = await supabase.from('paper_types').insert(rows);
  if (error) throw error;
};

export const createPaperType = async (shopId, pt) => {
  const { data: maxOrderData } = await supabase.from('paper_types').select('sortorder').eq('shop_id', shopId).order('sortorder', { ascending: false }).limit(1);
  const maxOrder = maxOrderData?.[0]?.sortorder ?? -1;
  const newPt = {
    id: pt.id,
    shop_id: shopId,
    name: pt.name,
    namear: pt.nameAr || pt.name,
    colorperpage: pt.colorPerPage,
    blackwhiteperpage: pt.blackWhitePerPage,
    sortorder: maxOrder + 1,
  };
  const { error } = await supabase.from('paper_types').insert(newPt);
  if (error) throw error;
  const { data } = await supabase.from('paper_types').select('*').eq('shop_id', shopId).eq('id', pt.id).single();
  return data;
};

export const updatePaperType = async (shopId, id, updates) => {
  const setFields = {};
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.nameAr !== undefined) setFields.namear = updates.nameAr;
  if (updates.colorPerPage !== undefined) setFields.colorperpage = updates.colorPerPage;
  if (updates.blackWhitePerPage !== undefined) setFields.blackwhiteperpage = updates.blackWhitePerPage;
  if (updates.sortOrder !== undefined) setFields.sortorder = updates.sortOrder;
  if (Object.keys(setFields).length === 0) return null;
  const { error } = await supabase.from('paper_types').update(setFields).eq('shop_id', shopId).eq('id', id);
  if (error) throw error;
  const { data } = await supabase.from('paper_types').select('*').eq('shop_id', shopId).eq('id', id).single();
  return data;
};

export const deletePaperType = async (shopId, id) => {
  const { error } = await supabase.from('paper_types').delete().eq('shop_id', shopId).eq('id', id);
  if (error) throw error;
  const { data: remaining } = await supabase.from('paper_types').select('id').eq('shop_id', shopId).order('sortorder', { ascending: true });
  for (let i = 0; i < (remaining || []).length; i++) {
    await supabase.from('paper_types').update({ sortorder: i }).eq('shop_id', shopId).eq('id', remaining[i].id);
  }
};

/**
 * Discount Rules Helpers
 */
export const getDiscountRules = async (shopId) => {
  const { data, error } = await supabase.from('discount_rules').select('*').eq('shop_id', shopId).order('priority', { ascending: false }).order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(row => ({ ...row, is_active: Boolean(row.is_active) }));
};

export const getActiveDiscountRules = async (shopId) => {
  const { data, error } = await supabase.from('discount_rules').select('*').eq('shop_id', shopId).eq('is_active', 1).order('priority', { ascending: false });
  if (error) throw error;
  return (data || []).map(row => ({ ...row, is_active: Boolean(row.is_active) }));
};

export const createDiscountRule = async (shopId, rule) => {
  const { id, name, discount_type, discount_value, condition_type, threshold, max_discount_cap, priority, is_active } = rule;
  const { error } = await supabase.from('discount_rules').insert({
    id,
    shop_id: shopId,
    name, discount_type,
    discount_value,
    condition_type,
    threshold,
    max_discount_cap: max_discount_cap || null,
    priority: priority || 0,
    is_active: is_active ? 1 : 0,
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
  return rule;
};

export const updateDiscountRule = async (shopId, id, updates) => {
  const setFields = {};
  if (updates.name !== undefined) setFields.name = updates.name;
  if (updates.discount_type !== undefined) setFields.discount_type = updates.discount_type;
  if (updates.discount_value !== undefined) setFields.discount_value = updates.discount_value;
  if (updates.condition_type !== undefined) setFields.condition_type = updates.condition_type;
  if (updates.threshold !== undefined) setFields.threshold = updates.threshold;
  if (updates.max_discount_cap !== undefined) setFields.max_discount_cap = updates.max_discount_cap;
  if (updates.priority !== undefined) setFields.priority = updates.priority;
  if (updates.is_active !== undefined) setFields.is_active = updates.is_active ? 1 : 0;

  if (Object.keys(setFields).length === 0) return null;

  const { error } = await supabase.from('discount_rules').update(setFields).eq('shop_id', shopId).eq('id', id);
  if (error) throw error;
  return { id, ...updates };
};

export const deleteDiscountRule = async (shopId, id) => {
  const { error } = await supabase.from('discount_rules').delete().eq('shop_id', shopId).eq('id', id);
  if (error) throw error;
  return id;
};

/**
 * Blocked Uploaders
 *
 * Per-shop upload blocklist (see migration 002). Four identifier kinds — ip,
 * fingerprint, phone, user — each stored as one row, so an operator can block
 * a device without blocking a shared IP, or vice versa.
 */
export const BLOCK_KINDS = ['ip', 'fingerprint', 'phone', 'user'];

/**
 * Phones are compared digits-only so "0555 00 00 00", "+213555000000" and
 * "0555000000" can't be used to walk around a block by re-typing spaces.
 * A leading + is preserved as nothing (country code digits are kept), which
 * means a local and an international spelling of the same number still differ —
 * blocking both spellings is the operator's call.
 */
export const normalizeBlockValue = (kind, value) => {
  const raw = String(value ?? '').trim();
  if (kind === 'phone') return raw.replace(/\D/g, '');
  if (kind === 'ip') return raw.toLowerCase();
  return raw;
};

/** sha256 of the browser's persisted device id — what we store and compare. */
export const hashFingerprint = (deviceId) => {
  const raw = String(deviceId || '').trim();
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex');
};

export const listBlockedUploaders = async (shopId) => {
  const { data, error } = await supabase
    .from('blocked_uploaders')
    .select('*')
    .eq('shop_id', shopId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    kind: row.kind,
    value: row.value,
    reason: row.reason || '',
    label: row.label || '',
    createdAt: row.created_at,
  }));
};

/**
 * Block one identifier. Re-blocking an existing value updates its reason/label
 * in place rather than erroring on the unique index, so the operator's second
 * attempt (with a better note) does what they expect.
 */
export const addBlockedUploader = async (shopId, { kind, value, reason = '', label = '' }) => {
  if (!BLOCK_KINDS.includes(kind)) throw new Error(`Unknown block kind: ${kind}`);
  const normalized = normalizeBlockValue(kind, value);
  if (!normalized) throw new Error('Block value is required');

  const row = {
    id: randomUUID(),
    shop_id: shopId,
    kind,
    value: normalized,
    reason: String(reason || '').slice(0, 500),
    label: String(label || '').slice(0, 200),
  };
  const { data, error } = await supabase
    .from('blocked_uploaders')
    .upsert(row, { onConflict: 'shop_id,kind,value', ignoreDuplicates: false })
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    kind: data.kind,
    value: data.value,
    reason: data.reason || '',
    label: data.label || '',
    createdAt: data.created_at,
  };
};

export const removeBlockedUploader = async (shopId, id) => {
  const { error } = await supabase
    .from('blocked_uploaders')
    .delete()
    .eq('shop_id', shopId)
    .eq('id', id);
  if (error) throw error;
  return id;
};

/**
 * Return the first block matching any identifier of this uploader, or null.
 *
 * One query per call, filtered by shop and by the handful of values in play —
 * the upload path runs this on every request, so it must not grow with the
 * size of the blocklist.
 */
export const findUploaderBlock = async (shopId, { ip, fingerprint, phone, userId } = {}) => {
  const candidates = [];
  if (ip) candidates.push(['ip', normalizeBlockValue('ip', ip)]);
  if (fingerprint) candidates.push(['fingerprint', fingerprint]);
  if (phone) candidates.push(['phone', normalizeBlockValue('phone', phone)]);
  if (userId) candidates.push(['user', String(userId)]);

  const values = candidates.map(([, v]) => v).filter(Boolean);
  if (values.length === 0) return null;

  const { data, error } = await supabase
    .from('blocked_uploaders')
    .select('*')
    .eq('shop_id', shopId)
    .in('value', values);
  if (error) throw error;

  // `in('value', ...)` can't express the (kind, value) pairing, so the kind is
  // matched here — otherwise a blocked phone number would also block an IP
  // that happened to be spelled the same way.
  const hit = (data || []).find((row) =>
    candidates.some(([kind, value]) => row.kind === kind && row.value === value),
  );
  if (!hit) return null;
  return { id: hit.id, kind: hit.kind, value: hit.value, reason: hit.reason || '' };
};

export { supabase as default };
