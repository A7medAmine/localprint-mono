# LocalPrint Cloud (online) — Agent Guide

Multi-tenant cloud upload portal: customers upload print jobs to a shop's page,
the desktop app syncs them down. Part of the LocalPrint monorepo — see the root
`AGENTS.md` for workspace-wide rules (install from root, `@localprint/shared`,
etc.).

## Quick start
```bash
# from the monorepo root: npm install   (never install inside this app)
npm run dev       -w @localprint/online   # Vite (5000) + Express (5001) concurrently
npm run build     -w @localprint/online   # Vite build to dist/
npm start         -w @localprint/online   # production: serves dist/ + API on port 3000
npm run typecheck -w @localprint/online
npm run lint      -w @localprint/online
npm run test      -w @localprint/online   # vitest
```

## Architecture
- **Frontend**: React 19 + TypeScript + Vite. Dev server on port **5000**,
  proxies `/api` to `http://localhost:5001`.
- **Backend**: Express 5 (ESM). Port **5001** in dev, **3000** in production
  (`PORT || (isDev ? 5001 : 3000)`).
- **DB**: Supabase (Postgres) via `@supabase/supabase-js`. Main table `orders`;
  shop config in a settings table. **Multi-tenant**: every query is scoped by
  `shop_id` (resolved from the `shopSlug` in the URL). Never run a shop-scoped
  query without the `shop_id` filter.
- **Auth**: Supabase JWTs verified with `jose`. `db.js` holds a short-TTL token
  cache (see `utils/authCache.js`). Desktop→cloud sync authenticates with
  `SHOP_API_TOKEN`.

## Column naming
Postgres columns are **lowercase** (e.g. `customername`, `pagecount`,
`colormode`), with two snake_case exceptions: `total_price` and
`rejection_reason`. `utils/orderMapping.js` maps between the DB shape and the
camelCase API shape (`toApiOrder` / `fromApiOrder`) — use it rather than
hand-writing column names. Phase 4.3 makes this the canonical shared shape.

## Secrets & settings
- `.env` holds `SUPABASE_SERVICE_KEY`, `SHOP_API_TOKEN`, `VITE_SUPABASE_ANON_KEY`,
  and a Postgres connection string. Gitignored/dockerignored — never commit it.
- Only keys in the `PUBLIC_SETTINGS_KEYS` allowlist are returned from public
  settings endpoints. Keep everything else server-side.

## Migrations
Numbered SQL under `supabase/migrations/` (`001…005.sql`). Phase 4.4 formalizes
the runner shared with the desktop app.

## Key conventions
- **ESM only** (`"type": "module"`).
- **File uploads**: Multer; magic-byte validation via `utils/fileValidation.js`;
  server-side PDF page counting via `utils/pdfPageCount.js` (pdf-lib).
- **Deploy**: Dockerfile sets `NODE_ENV=production`. Phase 4.7 rewrites it
  multi-stage/non-root with an uploads volume; see `DEPLOYMENT.md` (added in 4.7).
