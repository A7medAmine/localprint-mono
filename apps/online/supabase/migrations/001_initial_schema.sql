-- LocalPrint-online — complete baseline schema.
--
-- This single migration creates the entire public schema from nothing. It
-- replaces the old 001..007 chain, which assumed the four base tables
-- (orders, settings, paper_types, discount_rules) had already been created by
-- hand in the Supabase dashboard and therefore could never bootstrap a fresh
-- project.
--
-- Every statement is idempotent, so it is safe to re-run against a database
-- that is already at this baseline.
--
-- Apply with:
--   supabase db push
-- or paste into the Supabase SQL editor.

begin;

-- ── shops ────────────────────────────────────────────────────────────────
-- One row per print shop (tenant). `token_hash` is the sha256 of the API
-- token handed to that shop's desktop app; the plaintext is never stored.
create table if not exists shops (
  id          text primary key,
  slug        text        not null unique,
  name        text        not null,
  token_hash  text        not null unique,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ── settings ─────────────────────────────────────────────────────────────
-- Key/value shop settings. Values are stored as text; objects are JSON
-- strings (see db.js getSettings/updateSetting).
create table if not exists settings (
  shop_id text not null references shops (id) on delete cascade,
  key     text not null,
  value   text,
  primary key (shop_id, key)
);

-- ── paper_types ──────────────────────────────────────────────────────────
-- Column names are lowercase-no-separator on purpose: they mirror the desktop
-- SQLite schema so the sync payload maps 1:1 with no renaming.
create table if not exists paper_types (
  id                text primary key,
  shop_id           text not null references shops (id) on delete cascade,
  name              text not null,
  namear            text not null default '',
  colorperpage      real not null default 30,
  blackwhiteperpage real not null default 15,
  sortorder         integer not null default 0
);

create index if not exists paper_types_shop_id_idx on paper_types (shop_id);

-- ── discount_rules ───────────────────────────────────────────────────────
-- `is_active` is an integer 0/1 (not boolean) to match the desktop SQLite
-- source of truth; db.js coerces it to a JS boolean on read.
create table if not exists discount_rules (
  id               text primary key,
  shop_id          text not null references shops (id) on delete cascade,
  name             text not null,
  discount_type    text not null,
  discount_value   real not null,
  condition_type   text not null,
  threshold        integer not null,
  max_discount_cap real,
  priority         integer not null default 0,
  is_active        integer not null default 1,
  created_at       timestamptz not null default now()
);

create index if not exists discount_rules_shop_id_idx on discount_rules (shop_id);

-- ── profiles ─────────────────────────────────────────────────────────────
-- Optional customer accounts (Supabase Auth). Accounts are platform-global:
-- one login uploads to any shop. Guest (unauthenticated) uploads never touch
-- this table. Rows are upserted by the backend on first profile read/save, so
-- no auth.users trigger is needed.
create table if not exists profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  name                  text,
  phone                 text,
  email                 text,
  default_paper_type_id text,
  default_copies        integer,
  created_at            timestamptz not null default now()
);

-- ── orders ───────────────────────────────────────────────────────────────
-- `uploaddate` stays text (the desktop app's own format) — do not "fix" it to
-- timestamptz without changing both sides of the sync.
create table if not exists orders (
  id                text primary key,
  shop_id           text not null references shops (id) on delete cascade,
  -- null for guest uploads, which are the default
  user_id           uuid references auth.users (id) on delete set null,
  customername      text default '',
  phonenumber       text default '',
  notes             text default '',
  filename          text,
  filetype          text,
  filesize          bigint,
  uploaddate        text,
  status            text default 'PENDING',
  serverfilename    text,
  pagecount         integer,
  colormode         text default 'color',
  copies            integer default 1,
  papertype         text default 'normal',
  source            text default 'upload',
  shopsyncstatus    text default 'pending',
  rejection_reason  text,
  total_price       numeric,
  -- sha256 of the per-upload delete secret; plaintext is shown to the
  -- uploader exactly once and never stored
  delete_token_hash text,
  -- set when a signed-in customer's upload had to be filed as a guest because
  -- Supabase auth was briefly unavailable; reconciled later by email/phone
  auth_deferred     boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists orders_shop_id_idx on orders (shop_id);
create index if not exists orders_shop_id_shopsyncstatus_idx on orders (shop_id, shopsyncstatus);
create index if not exists orders_user_id_idx on orders (user_id);

-- ── atomic discount-rule replace ─────────────────────────────────────────
-- The settings-sync endpoint used to DELETE then INSERT a shop's rules in two
-- round-trips with a JS snapshot-rollback, which can leave a half-applied set
-- if the second call fails. This does the replace in one transaction.
create or replace function replace_shop_discount_rules(
  p_shop_id text,
  p_rules   jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from discount_rules where shop_id = p_shop_id;

  insert into discount_rules (
    id, shop_id, name, discount_type, discount_value,
    condition_type, threshold, max_discount_cap, priority, is_active, created_at
  )
  select
    r->>'id',
    p_shop_id,
    r->>'name',
    r->>'discount_type',
    (r->>'discount_value')::numeric,
    r->>'condition_type',
    (r->>'threshold')::integer,
    nullif(r->>'max_discount_cap', '')::numeric,
    coalesce((r->>'priority')::integer, 0),
    case when coalesce(r->>'is_active', '1') in ('1', 'true') then 1 else 0 end,
    coalesce((r->>'created_at')::timestamptz, now())
  from jsonb_array_elements(p_rules) as r;
end;
$$;

-- security definer + a public schema search_path means anyone who can reach
-- the RPC runs it as the owner. Only the service_role backend should call it.
revoke all on function replace_shop_discount_rules(text, jsonb) from public, anon, authenticated;

-- ── Row Level Security ───────────────────────────────────────────────────
-- The Express backend always uses the service_role key, which bypasses RLS
-- entirely, so none of this affects server-side behavior. It exists so the
-- anon/publishable key (shipped to every browser) cannot read or write these
-- tables directly. Deny-by-default: a table with RLS on and no policy is
-- fully closed to anon/authenticated.
alter table shops          enable row level security;
alter table settings       enable row level security;
alter table paper_types    enable row level security;
alter table discount_rules enable row level security;
alter table profiles       enable row level security;
alter table orders         enable row level security;

-- The only intentionally open paths: a signed-in customer reading/writing
-- their own profile, and reading their own cross-shop order history.
--
-- auth.uid() is wrapped in (select ...) so Postgres evaluates it once as an
-- InitPlan instead of re-running it per row (Supabase linter 0003).
drop policy if exists "Users can view own profile" on profiles;
create policy "Users can view own profile" on profiles
  for select using ((select auth.uid()) = id);

drop policy if exists "Users can insert own profile" on profiles;
create policy "Users can insert own profile" on profiles
  for insert with check ((select auth.uid()) = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "Customers can view their own orders" on orders;
create policy "Customers can view their own orders" on orders
  for select using ((select auth.uid()) = user_id);

commit;
