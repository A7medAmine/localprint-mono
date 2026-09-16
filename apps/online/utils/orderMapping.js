// Online order mappers. The canonical order shape and the rename logic now live
// in @atba3li/shared/orderShape; this thin wrapper binds them to the online
// Postgres column map and preserves the names server.js / db.js already import.
//
// Deliberately kept pure (no ./db.js import, which would drag in supabase +
// checkEnv) so the round-trip test can load it without real env.
import { ONLINE_ORDER_COLUMNS, makeOrderMappers } from '@atba3li/shared/orderShape';

export const ORDER_FIELD_MAP = ONLINE_ORDER_COLUMNS;

const { toApi, fromApi } = makeOrderMappers(ONLINE_ORDER_COLUMNS);

// db row (lowercase columns) -> API object (camelCase).
export const toApiOrder = toApi;
// API object (camelCase) -> db row (lowercase columns).
export const fromApiOrder = fromApi;
