// Type declarations for orderShape.js (plain .js so the Node servers can
// import it). Kept in sync with that file by hand.

export type OrderField =
  | 'id'
  | 'orderId'
  | 'customerName'
  | 'customerEmail'
  | 'phoneNumber'
  | 'notes'
  | 'fileName'
  | 'fileType'
  | 'fileSize'
  | 'uploadDate'
  | 'status'
  | 'serverFileName'
  | 'pageCount'
  | 'colorMode'
  | 'copies'
  | 'paperType'
  | 'source'
  | 'totalPrice'
  | 'shopSyncStatus'
  | 'rejectionReason'
  | 'uploaderIp'
  | 'uploaderFingerprint';

export const ORDER_FIELDS: OrderField[];

/** camelCase field -> storage column name, a subset of the canonical fields. */
export type OrderColumnMap = Partial<Record<OrderField, string>>;

export const ONLINE_ORDER_COLUMNS: OrderColumnMap;
export const DESKTOP_ORDER_COLUMNS: OrderColumnMap;

/** The canonical camelCase order/job shape at an API boundary (flattened). */
export interface OrderApiShape {
  id?: string;
  orderId?: string;
  customerName?: string;
  customerEmail?: string;
  phoneNumber?: string;
  notes?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  uploadDate?: string;
  status?: string;
  serverFileName?: string;
  pageCount?: number | null;
  colorMode?: string;
  copies?: number;
  paperType?: string;
  source?: string;
  totalPrice?: number;
  shopSyncStatus?: string;
  rejectionReason?: string;
  uploaderIp?: string;
  uploaderFingerprint?: string;
}

export function makeOrderMappers(columnMap: OrderColumnMap): {
  toApi: (row: Record<string, unknown> | null | undefined) => OrderApiShape;
  fromApi: (obj: OrderApiShape | Record<string, unknown> | null | undefined) => Record<string, unknown>;
};
