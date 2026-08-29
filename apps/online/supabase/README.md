# Supabase Migrations (online)

This directory is the **source of truth** for the online Postgres schema. Do
not run ad-hoc `db.exec(...)` / dashboard `ALTER TABLE` — every schema change is
a new numbered `.sql` migration here, applied in order.

## Workflow

Create a new migration:

```bash
supabase migration new <name>
```

This scaffolds `supabase/migrations/<timestamp>_<name>.sql` (or edit the
numbering by hand to keep `001_…`, `002_…` order). Fill in the SQL, then apply:

```bash
supabase db push          # apply pending migrations to the linked project
supabase db reset         # drop + re-apply ALL migrations on a scratch project
```

For a production project, `supabase db push` runs only the migrations not yet
recorded in `supabase_migrations.schema_migrations` — forward-only, in order.

## Conventions

- **One concern per file**, named `NNN_<slug>.sql`, never edited after it has
  been applied anywhere (forward-only). A new change is a new file.
- Use `create table if not exists` / `alter table … add column if not exists`
  so re-runs on already-migrated databases are harmless.
- The pre-migration base tables (`orders`, `settings`, `paper_types`,
  `discount_rules`) were created manually in the Supabase dashboard before
  versioning existed; `001` onward assumes they exist. Do not recreate them
  here — new installs should provision them via the migrations as documented
  in `DEPLOYMENT.md`.
- Multi-tenant: every row carries a `shop_id`; keep `shop_id` in every new
  table and index it.
