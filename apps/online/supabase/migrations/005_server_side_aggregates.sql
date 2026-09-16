-- 005 — move the work Postgres should be doing out of Node.
--
-- Two hot paths were pulling whole tables across the wire to compute something
-- SQL does in one pass. Both are now functions.
--
-- Safe to re-run.

begin;

-- ── platform stats ───────────────────────────────────────────────────────
-- getPlatformStats() used to `select` EVERY order row and sum them in JS. Two
-- problems, the second one silent and worse:
--
--   1. the whole orders table crosses the network on every dashboard load;
--   2. PostgREST caps a response at max-rows (1000 by default), so past a
--      thousand orders the dashboard was not slow, it was WRONG — it summed
--      the first page and reported it as the platform total.
--
-- Returns a single jsonb document in the exact shape the admin console already
-- renders (platform-admin.js renderStats/renderShops), so the client is
-- unchanged.
create or replace function get_platform_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with per_shop as (
    select
      s.id,
      s.slug,
      s.name,
      s.is_active,
      count(o.id)                                                   as order_count,
      coalesce(sum(coalesce(o.pagecount, 0) * greatest(coalesce(o.copies, 1), 1)), 0) as total_pages,
      coalesce(sum(coalesce(o.total_price, 0)), 0)                  as revenue,
      count(o.id) filter (where o.uploaded_at >= now() - interval '30 days') as orders_30d
    from shops s
    left join orders o on o.shop_id = s.id
    group by s.id, s.slug, s.name, s.is_active
  )
  select jsonb_build_object(
    'totalShops',    (select count(*) from per_shop),
    'activeShops',   (select count(*) from per_shop where is_active is not false),
    'totalOrders',   (select coalesce(sum(order_count), 0) from per_shop),
    'totalPages',    (select coalesce(sum(total_pages), 0) from per_shop),
    'totalRevenue',  (select coalesce(sum(revenue), 0) from per_shop),
    'ordersLast30d', (select coalesce(sum(orders_30d), 0) from per_shop),
    'shops', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', id,
          'slug', slug,
          'name', name,
          'isActive', is_active is not false,
          'orderCount', order_count,
          'totalPages', total_pages
        )
        order by order_count desc
      )
      from per_shop
    ), '[]'::jsonb)
  );
$$;

-- The Express backend calls this with the service_role key. Nothing reachable
-- with the browser's publishable key has any business reading platform totals.
revoke all on function get_platform_stats() from public, anon, authenticated;

-- ── paper-type delete + resequence ───────────────────────────────────────
-- deletePaperType() issued one UPDATE per surviving row to close the gap in
-- sortorder — N round-trips, non-atomic, and a failure halfway left the list
-- numbered inconsistently. One statement instead.
create or replace function delete_paper_type(
  p_shop_id text,
  p_id      text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from paper_types where shop_id = p_shop_id and id = p_id;

  update paper_types pt
     set sortorder = ranked.rn
    from (
      select id, (row_number() over (order by sortorder, id) - 1)::integer as rn
      from paper_types
      where shop_id = p_shop_id
    ) ranked
   where pt.shop_id = p_shop_id
     and pt.id = ranked.id
     and pt.sortorder is distinct from ranked.rn;
end;
$$;

revoke all on function delete_paper_type(text, text) from public, anon, authenticated;

-- ── cleanup support ──────────────────────────────────────────────────────
-- cleanupOldOrders() selected every expired row in full (`select *`, file
-- columns and all) and then deleted them ONE AT A TIME. It only needs the
-- filenames, so it can unlink the files, and then one bulk delete.
--
-- Returns the server filenames it removed; the caller unlinks those and the
-- rows are already gone.
create or replace function delete_claimed_orders_before(
  p_cutoff timestamptz,
  p_limit  integer default 1000
) returns jsonb
language sql
security definer
set search_path = public
as $$
  with doomed as (
    select id
    from orders
    where shopsyncstatus = 'claimed'
      and uploaded_at < p_cutoff
    order by uploaded_at
    limit p_limit
  ), gone as (
    delete from orders
    where id in (select id from doomed)
    returning serverfilename
  )
  -- `deleted` is every row removed, `files` only those that had something on
  -- disk. The caller batches on `deleted`: a batch where no row happened to
  -- carry a filename is not an empty batch, and must not stop the loop.
  select jsonb_build_object(
    'deleted', (select count(*) from gone),
    'files', coalesce(
      (select jsonb_agg(serverfilename) from gone where serverfilename is not null),
      '[]'::jsonb
    )
  );
$$;

revoke all on function delete_claimed_orders_before(timestamptz, integer) from public, anon, authenticated;

-- ── background-maintenance lease ─────────────────────────────────────────
-- The cleanup job (and the page-count backfill) walk the whole orders table.
-- With more than one web instance every copy would do the same work, race the
-- same rows and unlink the same files, so only one may run a given job.
--
-- NOT pg_advisory_lock: Supabase fronts Postgres with a transaction-mode
-- pooler, so consecutive PostgREST calls are not guaranteed the same backend
-- connection. A session-level lock taken by one call could not be released by
-- the next, and the job would be wedged until that connection happened to die.
--
-- A lease row is connection-agnostic. It is taken with a single conditional
-- upsert, and it EXPIRES, so an instance that crashes mid-job blocks the next
-- run for at most the TTL rather than forever.
create table if not exists maintenance_leases (
  name        text primary key,
  holder      text        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

alter table maintenance_leases enable row level security;

create or replace function take_maintenance_lease(
  p_name        text,
  p_holder      text,
  p_ttl_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_taken boolean;
begin
  insert into maintenance_leases (name, holder, acquired_at, expires_at)
  values (p_name, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder      = excluded.holder,
        acquired_at = excluded.acquired_at,
        expires_at  = excluded.expires_at
    -- Only a lease nobody holds any more can be taken over.
    where maintenance_leases.expires_at < now()
  returning true into v_taken;

  return coalesce(v_taken, false);
end;
$$;

-- Releasing is scoped to the holder so a slow instance whose lease already
-- expired cannot delete the lease its successor now holds.
create or replace function release_maintenance_lease(
  p_name   text,
  p_holder text
) returns void
language sql
security definer
set search_path = public
as $$
  delete from maintenance_leases where name = p_name and holder = p_holder;
$$;

revoke all on function take_maintenance_lease(text, text, integer) from public, anon, authenticated;
revoke all on function release_maintenance_lease(text, text) from public, anon, authenticated;

commit;
