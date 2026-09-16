# Atba3li monorepo — Agent Guide

npm-workspaces monorepo holding both Atba3li apps plus their shared code.

## Layout
```
apps/desktop        Electron print-shop app (better-sqlite3, native printing, Gmail intake)
apps/online         Cloud upload portal (Express + Supabase, multi-tenant by shop)
packages/shared     Code shared by both apps (UI components, pricing,
                    validation, HTTP middleware, order mapping)
```
Each app has its own `AGENTS.md` with app-specific details — read that one when
working inside an app.

## Workspaces
- Root `package.json` declares `workspaces: ["apps/*", "packages/*"]`.
- **Install once, from the root** (`npm install`). Deps hoist to the root
  `node_modules`; there are no per-app lockfiles. Running `npm install` inside an
  app is wrong — it builds an un-hoisted tree.
- Shared code is imported as `@atba3li/shared`. Both apps map that specifier
  to `packages/shared/src` in their `tsconfig.json` (`paths`) and `vite.config.ts`
  (`resolve.alias`), so Vite bundles the shared TypeScript source directly — no
  separate build step.

## Root commands (fan out across workspaces)
```bash
npm run typecheck    # tsc --noEmit in every workspace that defines it
npm run lint         # eslint across workspaces
npm run test         # vitest run across workspaces
npm run build        # vite build across workspaces
```
Run an app's script alone with `npm run <script> -w @atba3li/desktop`
(or `-w @atba3li/online`).

## Shared config
- `tsconfig.base.json` — common compiler options; each app's tsconfig extends it.
  `strict` is **on**. Each app's tsconfig also sets an `exclude` list; keep
  build output (`dist`, `release`) out of it or `tsc --noEmit` picks up stale
  bundles and fails.
- Root `eslint.config.js` lints only root-level files; each app owns its own flat
  ESLint config.

## Conventions
- **ESM everywhere** (`"type": "module"`).
- Real secrets live in each app's `.env`, which is gitignored and dockerignored —
  **never commit `.env`**. Keep secret settings out of any serialized API
  response (see each app's guide for the allowlist).

## History
Built with history-preserving `git subtree` from the two original repos. The
originals remain on disk as a backup until the monorepo is fully verified.
