-- Phase 4.5: replace a shop's discount rules atomically.
--
-- The settings-sync endpoint used to DELETE then INSERT the shop's rules in two
-- round-trips with a JS snapshot-rollback. That is racy: a mid-sync failure can
-- leave the shop with a half-applied set. This function does the same replace
-- inside a single transaction, so it either fully applies or not at all.

create or replace function replace_shop_discount_rules(
  p_shop_id text,
  p_rules jsonb
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
