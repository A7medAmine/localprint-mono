// Canonical order/job shape + per-storage column mappers.
//
// One camelCase JSON shape crosses every API boundary (upload response, shop
// sync, customer order lists). Each storage backend owns the mapping between
// that shape and its own column names via `makeOrderMappers(columnMap)`:
//
//   - online Postgres stores lowercase/snake columns (`serverfilename`,
//     `total_price`, ...) — its mapper does the real rename.
//   - desktop SQLite already stores camelCase columns — its mapper is an
//     identity over the shared fields, kept so both apps funnel through the
//     same code and the round-trip guarantee (test) covers both.
//
// This module is plain `.js` (with a co-located `.d.ts`) because the Node
// servers import it directly and cannot load `.ts`. It is pure and free of
// side effects, so the round-trip test can import the column maps without
// pulling in better-sqlite3 / supabase.

// The authoritative camelCase field names an order/job may expose at an API
// boundary. Every backend column map's keys must be a subset of this list —
// the round-trip test enforces it, so a stray/renamed field can't drift in.
export const ORDER_FIELDS = [
  'id',
  // Groups every file from one upload submission into a single order — set
  // once per submit batch, shared by all the files it contains, so files
  // that finish uploading at different times still belong to one order
  // instead of splitting into one order per file.
  'orderId',
  'customerName',
  'customerEmail',
  'phoneNumber',
  'notes',
  'fileName',
  'fileType',
  'fileSize',
  'uploadDate',
  'status',
  'serverFileName',
  'pageCount',
  'colorMode',
  'copies',
  'paperType',
  'source',
  'totalPrice',
  'shopSyncStatus',
  'rejectionReason',
  'uploaderIp',
  'uploaderFingerprint',
];

// camelCase field -> online Postgres column (lowercase, a few snake_case).
// The full order row correspondence, extracted verbatim from the server.js
// handlers. `toApi` is a superset serializer; endpoints that must not expose a
// given field (e.g. the public order query hiding customerName/serverFileName,
// or shop/pending hiding totalPrice) project it away explicitly at the call
// site rather than relying on the mapper to omit it.
export const ONLINE_ORDER_COLUMNS = {
  id: 'id',
  orderId: 'order_id',
  customerName: 'customername',
  phoneNumber: 'phonenumber',
  notes: 'notes',
  fileName: 'filename',
  fileType: 'filetype',
  fileSize: 'filesize',
  uploadDate: 'uploaddate',
  status: 'status',
  serverFileName: 'serverfilename',
  pageCount: 'pagecount',
  colorMode: 'colormode',
  copies: 'copies',
  paperType: 'papertype',
  source: 'source',
  totalPrice: 'total_price',
  shopSyncStatus: 'shopsyncstatus',
  rejectionReason: 'rejection_reason',
  // Captured at upload time so a shop can block the sender of an order it
  // already received. Projected away on every customer-facing endpoint.
  uploaderIp: 'uploader_ip',
  uploaderFingerprint: 'uploader_fingerprint',
};

// camelCase field -> desktop SQLite column. Columns are already camelCase, so
// this is an identity map over the fields the `jobs` table shares with the
// canonical shape. The desktop admin API returns a wider superset row
// (payment*, cloudOrderId, ...); those extras are desktop-only and are not
// routed through these mappers.
export const DESKTOP_ORDER_COLUMNS = {
  id: 'id',
  orderId: 'orderId',
  customerName: 'customerName',
  customerEmail: 'customerEmail',
  phoneNumber: 'phoneNumber',
  notes: 'notes',
  fileName: 'fileName',
  fileType: 'fileType',
  fileSize: 'fileSize',
  uploadDate: 'uploadDate',
  status: 'status',
  serverFileName: 'serverFileName',
  pageCount: 'pageCount',
  colorMode: 'colorMode',
  copies: 'copies',
  paperType: 'paperType',
  source: 'source',
};

/**
 * Build `{ toApi, fromApi }` for a given camelCase-field -> column dictionary.
 *
 * `toApi(row)`   picks the mapped columns out of a storage row and returns the
 *                canonical camelCase object (unmapped columns are ignored, so a
 *                `SELECT *` row's internal columns never leak).
 * `fromApi(obj)` does the inverse: canonical camelCase -> storage columns,
 *                copying only the fields present on `obj`.
 *
 * Both copy a field only when its source value is `!== undefined`, so absent
 * fields stay absent rather than becoming explicit `undefined`s. Over any row
 * that contains exactly the mapped columns the pair is a bijection, which is
 * what the round-trip test asserts.
 */
export function makeOrderMappers(columnMap) {
  const camelKeys = Object.keys(columnMap);

  const toApi = (row) => {
    if (!row) return row;
    const out = {};
    for (const camel of camelKeys) {
      const col = columnMap[camel];
      if (row[col] !== undefined) out[camel] = row[col];
    }
    return out;
  };

  const fromApi = (obj) => {
    if (!obj) return obj;
    const out = {};
    for (const camel of camelKeys) {
      if (obj[camel] !== undefined) out[columnMap[camel]] = obj[camel];
    }
    return out;
  };

  return { toApi, fromApi };
}
