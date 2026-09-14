# Supabase Migrations (online)

This directory is the **source of truth** for the online Postgres schema. Do
not run ad-hoc `db.exec(...)` / dashboard `ALTER TABLE` — every schema change is
a new numbered `.sql` migration here, applied in order.

## Files

| File | Purpose |
|---|---|
| `migrations/001_initial_schema.sql` | The complete schema, from nothing. Idempotent — safe to re-run. |
| `reset.sql` | **Destructive.** Drops every LocalPrint table and its data. Never run by `db push`; run it by hand only to wipe a project. |

`001_initial_schema.sql` replaced the old `001…007` chain. That chain could not
bootstrap a fresh project: the four base tables (`orders`, `settings`,
`paper_types`, `discount_rules`) had been created by hand in the dashboard
before versioning existed, so `001` onward only ever *altered* tables it did
not create. The baseline creates everything, and additionally fixes what the
old chain left implicit: `shop_id` foreign keys with `on delete cascade`, a
real `(shop_id, key)` primary key on `settings`, and RLS enabled on every
table (deny-by-default — the backend uses the service_role key, which bypasses
RLS, and the browser only ever talks to Express).

## Workflow

```bash
supabase link --project-ref <ref>
supabase db push          # apply pending migrations to the linked project
```

For a production project, `supabase db push` runs only the migrations not yet
recorded in `supabase_migrations.schema_migrations` — forward-only, in order.

To wipe and rebuild (destroys all data, including shop API tokens):

```bash
psql "$DATABASE_URL" -f supabase/reset.sql
psql "$DATABASE_URL" -f supabase/migrations/001_initial_schema.sql
node scripts/create-shop.js "<Shop Name>"   # tokens are hashed; re-mint each shop
```

## Conventions

- **One concern per file**, named `NNN_<slug>.sql`, never edited after it has
  been applied anywhere (forward-only). A new change is a new file — `002_…`
  onward builds on the baseline.
- Use `create table if not exists` / `alter table … add column if not exists`
  so re-runs on already-migrated databases are harmless.
- Multi-tenant: every row carries a `shop_id`; keep `shop_id` in every new
  table, index it, and give it `references shops (id) on delete cascade`.
- New tables get `enable row level security` with no policy unless a browser
  is genuinely meant to read them directly.
