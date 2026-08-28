# PrintShop Hub (desktop) — Agent Guide

Electron desktop app for a print shop: job intake (QR upload, Gmail), native
printing, and admin management. Part of the LocalPrint monorepo — see the root
`AGENTS.md` for workspace-wide rules (install from root, `@localprint/shared`,
etc.).

## Quick start
```bash
# from the monorepo root: npm install   (never install inside this app)
npm run electron:dev -w @localprint/desktop   # Electron + Vite, hot reload
npm run dev          -w @localprint/desktop   # browser-only: Vite + plain node server
npm run build        -w @localprint/desktop   # Vite build to dist/
npm run typecheck -w @localprint/desktop
npm run lint      -w @localprint/desktop
npm run test      -w @localprint/desktop      # vitest
```

## Architecture
- **Frontend**: React 19 + TypeScript + Vite. Dev server on port **3000**,
  proxies `/api` to `VITE_API_TARGET` (falls back to `http://localhost:3001`).
- **Backend**: Express 5 (ESM), embedded in the Electron main process. Port
  **47821** when run under Electron, **3001** as a plain-node dev server, **3000**
  in production. `electron:dev` sets `VITE_API_TARGET=http://localhost:47821`.
- **DB**: SQLite via `better-sqlite3` (`database.sqlite`, WAL mode). Tables:
  `jobs`, `settings`, `paper_types`, `discount_rules`, `gmail_account`,
  `processed_emails`, `gmail_pending`, `cloud_imports`, `inventory_items`,
  `inventory_adjustments`.
- **Gmail intake**: `googleapis` OAuth; tokens encrypted at rest with
  `TOKEN_ENCRYPTION_KEY`. The embedded server's port is baked into the Gmail
  redirect URI (see `electron/main.js`).
- **Native module**: `better-sqlite3` is compiled for Electron's ABI by the
  `postinstall` (`electron-rebuild`). To run the plain-node server instead, use
  `npm run rebuild:node` first.
- **pdf.js worker**: `postinstall` also runs `scripts/patch-pdfjs-worker.js`,
  which injects a `toHex` / `getOrInsertComputed` polyfill into pdfjs-dist's
  worker (Electron 33 ships Chromium 130, which lacks them). The script finds
  pdfjs-dist wherever it hoists. Without this patch, PDF preview throws
  "a.toHex is not a function" at runtime — do not remove it.

## Column naming
DB columns are **camelCase** (e.g. `customerName`, `paperType`, `paymentStatus`).
Phase 4.3 introduces a canonical shape + mappers shared with the online app.

## Key conventions
- **ESM only** (`"type": "module"`).
- **Hash / path routing**: `/admin` = admin panel, upload page otherwise.
- **i18n**: `localStorage` key `ps_language` (`"en"`/`"ar"`), RTL via `<html dir>`.
- **Admin auth**: single-operator, hardened in Phase 1. First run forces a
  password change via the onboarding wizard (`/admin/setup`).
- **File uploads**: Multer, stored in `uploads/` (gitignored, auto-created).
- **Mono-print hack**: grayscale printing uses CSS `grayscale` with `color:true`.
  `color:false` renders solid black on Windows/Electron 33 — **do not revert**.

## Secrets & settings
- `.env` holds `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, etc. Gitignored —
  never commit it.
- Secret settings keys (`SECRET_SETTINGS_KEYS`, e.g. admin token/password) are
  filtered out of `GET /api/settings` responses. Keep them filtered.

## API routes (all `/api`)
| Route | Method | Notes |
|---|---|---|
| `/upload` | POST | `multipart/form-data`: `file` + `metadata` (JSON string) |
| `/jobs` | GET, DELETE | |
| `/jobs/:id/file` | POST | Replace file for existing job |
| `/jobs/:id/status` | PUT | |
| `/jobs/:id/preferences` | PUT | `{colorMode, copies, paperType}` |
| `/settings` | GET, POST | Key-value shop config (secrets filtered on GET) |
| `/settings/logo` | POST | Upload shop logo |
| `/paper-types` | GET, POST, PUT, DELETE | Granular per-type CRUD |
| `/auth/verify` | POST | `{password}` → `{success}` |
| `/discount-rules` | GET, POST, PUT, DELETE | CRUD |
| `/gmail/*` | — | OAuth connect/callback + intake queue |

## Migrations
Currently inline in `db.js` (idempotent `CREATE TABLE IF NOT EXISTS` +
`try { ALTER TABLE ... } catch {}`). Phase 4.4 replaces this with a numbered
migration runner.
