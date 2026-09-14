-- DESTRUCTIVE — drops every LocalPrint table in the `public` schema and all
-- of its data, so the baseline migration can be applied to a clean slate.
--
-- Not a migration. It is never run by `supabase db push`; run it by hand only
-- when you deliberately want to wipe the project:
--
--   psql "$DATABASE_URL" -f supabase/reset.sql
--   psql "$DATABASE_URL" -f supabase/migrations/001_initial_schema.sql
--
-- What this does NOT touch: `auth.users`. Customer logins survive a reset.
-- To wipe those too, run separately:
--   delete from auth.users;

begin;

drop function if exists public.replace_shop_discount_rules(text, jsonb);

-- orders/settings/paper_types/discount_rules all FK to shops, so cascade
-- handles the ordering.
drop table if exists public.orders         cascade;
drop table if exists public.settings       cascade;
drop table if exists public.paper_types    cascade;
drop table if exists public.discount_rules cascade;
drop table if exists public.profiles       cascade;
drop table if exists public.shops          cascade;

commit;
