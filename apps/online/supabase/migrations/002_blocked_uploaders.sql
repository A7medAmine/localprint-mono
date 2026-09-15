-- Per-shop upload blocklist.
--
-- A shop operator blocks an abusive uploader from the desktop Admin panel; the
-- public upload endpoint refuses anything matching one of this shop's rows.
-- Blocks are per-shop on purpose: one store's abuser is not another's, and a
-- shared/NAT IP would otherwise take down uploads platform-wide.

begin;

-- Identifiers captured at upload time so an operator can block a sender
-- straight from an order they just received, rather than typing an IP by hand.
--   uploader_ip          — req.ip (Express is configured with trust proxy 1)
--   uploader_fingerprint — sha256 of the browser's persisted device id; stable
--                          across IP changes, cleared when the visitor wipes
--                          site data. Weak on its own, useful combined with IP.
alter table orders add column if not exists uploader_ip          text;
alter table orders add column if not exists uploader_fingerprint text;

create table if not exists blocked_uploaders (
  id         text primary key,
  shop_id    text        not null references shops (id) on delete cascade,
  -- which identifier `value` holds:
  --   ip          — client IP address
  --   fingerprint — sha256 device-id hash (see orders.uploader_fingerprint)
  --   phone       — phone number as entered on the order, digits only
  --   user        — Supabase auth user id (signed-in customers only)
  kind       text        not null check (kind in ('ip', 'fingerprint', 'phone', 'user')),
  value      text        not null,
  -- operator's own note, shown back in the block list
  reason     text        not null default '',
  -- denormalised label so the list stays readable after the order is gone
  label      text        not null default '',
  created_at timestamptz not null default now()
);

-- One row per identifier per shop; re-blocking the same value updates in place.
create unique index if not exists blocked_uploaders_shop_kind_value_idx
  on blocked_uploaders (shop_id, kind, value);

-- The upload path looks up every identifier of one uploader in a single
-- query filtered by shop, so shop_id leads the index.
create index if not exists blocked_uploaders_shop_id_idx
  on blocked_uploaders (shop_id);

-- Same deny-by-default posture as every other table: the Express backend uses
-- the service_role key and bypasses RLS, while the anon/publishable key
-- shipped to browsers gets nothing. No policies = fully closed.
alter table blocked_uploaders enable row level security;

commit;
