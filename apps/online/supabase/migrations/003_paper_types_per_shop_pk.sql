-- 003 — paper_types: scope the primary key to the shop, and make the
-- settings-sync replace atomic.
--
-- 001 gave paper_types `id text primary key`, which made the id GLOBAL rather
-- than per-tenant. Every desktop install seeds the same three ids ('normal',
-- 'glossy', 'cardboard'), so the second shop to run a settings sync hit
-- `duplicate key value violates unique constraint "paper_types_pkey"` against
-- the first shop's rows — replaceAllPaperTypes deletes only its own shop_id,
-- then inserts an id another shop already owns. Settings sync failed forever
-- for every shop after the first.
--
-- Safe to re-run.

begin;

-- ── per-shop primary key ─────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.paper_types'::regclass
      and conname  = 'paper_types_pkey'
      and pg_get_constraintdef(oid) <> 'PRIMARY KEY (shop_id, id)'
  ) then
    alter table paper_types drop constraint paper_types_pkey;
    alter table paper_types add constraint paper_types_pkey primary key (shop_id, id);
  end if;
end;
$$;

-- ── atomic paper-type replace ────────────────────────────────────────────
-- Mirrors replace_shop_discount_rules: the settings-sync endpoint used to
-- DELETE then INSERT in two round-trips, so a failure between them left the
-- shop with no paper types at all.
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
    coalesce((t.value->>'colorPerPage')::real, 30),
    coalesce((t.value->>'blackWhitePerPage')::real, 15),
    (t.ordinality - 1)::integer
  from jsonb_array_elements(p_types) with ordinality as t(value, ordinality);
end;
$$;

-- security definer + public search_path: only the service_role backend may
-- call this, same rationale as replace_shop_discount_rules.
revoke all on function replace_shop_paper_types(text, jsonb) from public, anon, authenticated;

commit;
