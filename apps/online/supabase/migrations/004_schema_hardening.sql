-- 004 — schema hardening: per-shop discount-rule ids, a real timestamp column,
-- status CHECKs, updated_at, and indexes that match the queries we actually run.
--
-- Safe to re-run; every statement is idempotent.

begin;

-- ── discount_rules: scope the primary key to the shop ────────────────────
-- Same defect 003 fixed for paper_types, still present here. `id` is generated
-- client-side in the desktop admin panel (SettingsPanel.tsx — 7 base36 chars
-- from Math.random), so it is unique per install, NOT per platform. Two shops
-- landing on the same id makes replace_shop_discount_rules() fail on
-- `duplicate key value violates unique constraint "discount_rules_pkey"`, and
-- that shop's settings sync is broken permanently.
--
-- Every read/write in db.js already filters on shop_id + id, so widening the
-- key needs no application change.
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.discount_rules'::regclass
      and conname  = 'discount_rules_pkey'
      and pg_get_constraintdef(oid) <> 'PRIMARY KEY (shop_id, id)'
  ) then
    alter table discount_rules drop constraint discount_rules_pkey;
    alter table discount_rules add constraint discount_rules_pkey primary key (shop_id, id);
  end if;
end;
$$;

-- discount_rules_shop_id_idx is now the leading column of the primary key's
-- index, so it is pure write overhead.
drop index if exists discount_rules_shop_id_idx;

-- ── orders.uploaded_at: a timestamp Postgres understands ─────────────────
-- `uploaddate` is text and stays text: it is part of the canonical order shape
-- that crosses the sync boundary (packages/shared/src/orderShape.js), and the
-- desktop app reads it verbatim. But every server-side date operation was
-- running as a LEXICAL STRING COMPARE against it:
--
--   cleanupOldOrders  .lt('uploaddate', sevenDaysAgoIso)
--   pending / query   .order('uploaddate', { ascending: false })
--
-- That happens to work today only because one writer exists (server.js upload,
-- `new Date().toISOString()`), and it is unindexed either way. This column is
-- the real thing: indexed, sortable, and correct regardless of text format.
alter table orders add column if not exists uploaded_at timestamptz;

-- Anything unparseable falls back to created_at rather than failing the
-- migration; the exception block keeps one bad string from taking the whole
-- statement down.
create or replace function parse_upload_date(p_text text, p_fallback timestamptz)
returns timestamptz
language plpgsql
as $$
begin
  if p_text is null or p_text = '' then
    return p_fallback;
  end if;
  return p_text::timestamptz;
exception when others then
  return p_fallback;
end;
$$;

update orders
   set uploaded_at = parse_upload_date(uploaddate, created_at)
 where uploaded_at is null;

-- Keep the two in lockstep from now on. A trigger rather than a generated
-- column because `text::timestamptz` reads DateStyle/TimeZone and is therefore
-- STABLE, not IMMUTABLE — declaring it immutable would let an index drift out
-- of sync with the data.
create or replace function orders_sync_uploaded_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.uploaded_at := parse_upload_date(new.uploaddate, coalesce(new.created_at, now()));
  return new;
end;
$$;

drop trigger if exists orders_sync_uploaded_at_trg on orders;
create trigger orders_sync_uploaded_at_trg
  before insert or update of uploaddate on orders
  for each row execute function orders_sync_uploaded_at();

-- ── updated_at everywhere ────────────────────────────────────────────────
-- Only created_at existed, which is why the desktop poll has to re-fetch every
-- pending order every 30s instead of asking for what changed since its last
-- tick. This is the column an incremental sync (and any cache invalidation)
-- needs to exist first.
create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['shops', 'settings', 'paper_types', 'discount_rules', 'orders', 'profiles']
  loop
    execute format(
      'alter table %I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('drop trigger if exists %I on %I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end;
$$;

-- ── enum CHECKs ──────────────────────────────────────────────────────────
-- Every one of these was free text with a default. A typo'd shopsyncstatus
-- wrote successfully and the order then silently never appeared in
-- /api/shop/pending again — a data-loss-shaped bug with no error anywhere.
--
-- Legacy variants are normalised first so the constraints can be added
-- VALIDATED (enforced against existing rows too), not NOT VALID.

-- status: the PrintStatus enum (packages/shared/src/types.ts) plus the
-- server-written 'rejected' (server.js:1205).
update orders set status = 'rejected'
 where lower(status) = 'rejected' and status <> 'rejected';
update orders set status = upper(status)
 where upper(status) in ('PENDING', 'READY', 'PRINTED') and status <> upper(status);
update orders set status = 'PENDING'
 where status is null
    or status not in ('PENDING', 'READY', 'PRINTED', 'rejected');

alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('PENDING', 'READY', 'PRINTED', 'rejected'));

-- colormode: the upload form's own values ("color" | "blackWhite"), stored
-- verbatim — note the camelCase, it is a JS union and not a SQL-style token.
update orders set colormode = 'blackWhite'
 where lower(colormode) in ('blackwhite', 'black_white', 'bw');
update orders set colormode = 'color'
 where colormode is null or colormode not in ('color', 'blackWhite');

alter table orders drop constraint if exists orders_colormode_check;
alter table orders add constraint orders_colormode_check
  check (colormode in ('color', 'blackWhite'));

-- shopsyncstatus: the entire cloud-sync state machine is these two values.
update orders set shopsyncstatus = 'pending'
 where shopsyncstatus is null or shopsyncstatus not in ('pending', 'claimed');

alter table orders drop constraint if exists orders_shopsyncstatus_check;
alter table orders add constraint orders_shopsyncstatus_check
  check (shopsyncstatus in ('pending', 'claimed'));

-- source: online orders are always customer uploads. Desktop-local sources
-- ('admin', gmail intake) never reach this table — cloudSync.js refuses to
-- push them — but they are allowed here so a future intake path does not need
-- a migration to land a row.
update orders set source = 'upload'
 where source is null or source not in ('upload', 'admin', 'gmail');

alter table orders drop constraint if exists orders_source_check;
alter table orders add constraint orders_source_check
  check (source in ('upload', 'admin', 'gmail'));

-- copies is multiplied into the page and revenue totals; a zero or negative
-- value silently corrupts them.
update orders set copies = 1 where copies is null or copies < 1;
alter table orders drop constraint if exists orders_copies_check;
alter table orders add constraint orders_copies_check check (copies >= 1);

-- ── money columns: real -> numeric ───────────────────────────────────────
-- These are prices. `real` is binary float: 30.1 does not round-trip, and the
-- price quoted to the customer is computed from them. orders.total_price is
-- already numeric, so the schema was inconsistent with itself.
alter table paper_types
  alter column colorperpage      type numeric using colorperpage::numeric,
  alter column blackwhiteperpage type numeric using blackwhiteperpage::numeric;

alter table discount_rules
  alter column discount_value type numeric using discount_value::numeric;

-- replace_shop_paper_types casts to ::real on insert — re-create it against
-- the new column type so the cast does not re-introduce the float error.
create or replace function replace_shop_paper_types(
  p_shop_id text,
  p_types   jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from paper_types where shop_id = p_shop_id;

  insert into paper_types (
    id, shop_id, name, namear, colorperpage, blackwhiteperpage, sortorder
  )
  select
    t.value->>'id',
    p_shop_id,
    t.value->>'name',
    coalesce(nullif(t.value->>'nameAr', ''), t.value->>'name'),
    coalesce((t.value->>'colorPerPage')::numeric, 30),
    coalesce((t.value->>'blackWhitePerPage')::numeric, 15),
    (t.ordinality - 1)::integer
  from jsonb_array_elements(p_types) with ordinality as t(value, ordinality);
end;
$$;

revoke all on function replace_shop_paper_types(text, jsonb) from public, anon, authenticated;
revoke all on function parse_upload_date(text, timestamptz) from public, anon, authenticated;

-- ── indexes matching the queries we actually run ─────────────────────────

-- GET /api/shop/pending and POST /api/s/:slug/orders/query both filter by shop
-- and sort by upload date descending.
create index if not exists orders_shop_id_uploaded_at_idx
  on orders (shop_id, uploaded_at desc);

-- cleanupOldOrders: shopsyncstatus = 'claimed' AND uploaded_at < cutoff. The
-- existing (shop_id, shopsyncstatus) index cannot serve it — the job is
-- platform-wide and has no shop_id to lead with.
create index if not exists orders_shopsyncstatus_uploaded_at_idx
  on orders (shopsyncstatus, uploaded_at);

-- getCustomerOrders sorts a user's cross-shop history by date.
create index if not exists orders_user_id_uploaded_at_idx
  on orders (user_id, uploaded_at desc)
  where user_id is not null;
drop index if exists orders_user_id_idx;

-- orders_shop_id_idx is a strict prefix of orders_shop_id_uploaded_at_idx.
drop index if exists orders_shop_id_idx;

-- listPublicShops filters settings by key across many shops.
create index if not exists settings_key_idx on settings (key);

-- The auth_deferred reconciliation path ("reconciled later by email/phone")
-- had no index to match on.
create index if not exists profiles_email_idx on profiles (lower(email)) where email is not null;
create index if not exists profiles_phone_idx on profiles (phone) where phone is not null;

commit;
