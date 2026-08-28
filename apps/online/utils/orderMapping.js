// Canonical camelCase order fields <-> the online Postgres column names
// (lowercase, with a few snake_case exceptions). Extracted verbatim from the
// server.js order handlers so the correspondence lives in one tested place.
// Phase 4.3 makes server.js consume these mappers instead of hand-building the
// objects inline; for now this is the characterized source of truth.
export const ORDER_FIELD_MAP = {
  id: "id",
  customerName: "customername",
  phoneNumber: "phonenumber",
  notes: "notes",
  fileName: "filename",
  fileType: "filetype",
  fileSize: "filesize",
  uploadDate: "uploaddate",
  status: "status",
  serverFileName: "serverfilename",
  pageCount: "pagecount",
  colorMode: "colormode",
  copies: "copies",
  paperType: "papertype",
  totalPrice: "total_price",
  source: "source",
  shopSyncStatus: "shopsyncstatus",
  rejectionReason: "rejection_reason",
};

const DB_TO_API = Object.fromEntries(
  Object.entries(ORDER_FIELD_MAP).map(([api, db]) => [db, api]),
);

// db row (lowercase columns) -> API object (camelCase). Only known columns are
// mapped; server-internal columns (shop_id, user_id, delete_token_hash, ...)
// and any other unknown keys are dropped, matching the hand-built serializers.
export function toApiOrder(row) {
  const out = {};
  for (const [db, api] of Object.entries(DB_TO_API)) {
    if (row[db] !== undefined) out[api] = row[db];
  }
  return out;
}

// API object (camelCase) -> db row (lowercase columns). Inverse of toApiOrder;
// unknown keys are dropped the same way.
export function fromApiOrder(obj) {
  const out = {};
  for (const [api, db] of Object.entries(ORDER_FIELD_MAP)) {
    if (obj[api] !== undefined) out[db] = obj[api];
  }
  return out;
}
