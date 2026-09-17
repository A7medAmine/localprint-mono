# Security model — Atba3li desktop

The desktop app is an Electron shell around an Express server (`server.js`) and a
local SQLite database. It runs on one machine in the print shop and is reachable
by customers on the shop LAN (for the QR-code upload page).

## Trust boundaries

| Caller | How they authenticate | What they can do |
|---|---|---|
| Shop operator (admin) | Password → bearer token | Everything: jobs, settings, printing, backup |
| Walk-in customer (LAN) | None; per-upload delete token | Upload a file, check/track/delete **their own** upload |
| Cloud sync | Per-shop token, outbound only | Pull orders from the online service |

There are no roles and no second operator account — a single hardened login.

## Operator authentication

- Password is scrypt-hashed (`salt:key` hex). The factory default is `admin123`;
  while it is unchanged the server sets `mustChangePassword` and `requireAdmin`
  permits only `/api/settings/password` and `/api/auth/logout`.
- Password policy: ≥ 8 chars, not all digits, not the default.
- Session tokens are random 32-byte hex, stored in `settings._admin_tokens` with
  `createdAt` / `lastUsedAt`. They expire after `ADMIN_TOKEN_IDLE_DAYS` (14) idle
  or `ADMIN_TOKEN_MAX_DAYS` (30) absolute, and are pruned on every check + hourly.
- `/api/auth/verify` only counts **failed** attempts toward the lockout:
  5 fails → 1 min, 10 → 15 min, per IP; lockouts are logged.
- Changing the password invalidates every other token. `/api/auth/logout-all`
  does the same on demand.

## Secrets

- `_admin_tokens`, `adminPassword`, and Gmail OAuth tokens are **never** returned
  by any endpoint. `GET /api/settings` is public and returns an allowlist only
  (`PUBLIC_SETTINGS_KEYS`); the admin UI uses `GET /api/settings/admin`.
- `TOKEN_ENCRYPTION_KEY` (Gmail token encryption at rest) comes from `.env` in
  dev; a packaged build generates a per-install key under `userData/token.key`.
  `.env` is **not** bundled into the installer.

## File & job access

- Job ids and the per-upload `deleteToken` are generated **server-side**
  (`randomUUID` / 16 random bytes). Only the sha256 of the delete token is
  stored (`jobs.deleteTokenHash`).
- `DELETE /api/jobs/:id` requires the matching `deleteToken` (or an admin token).
- `/api/files/public/:id` serves a file only if the job has cleared review;
  non-inline types get `Content-Disposition: attachment`.
- `/api/files/review/:id` serves the same file regardless of review state, so
  the operator can look at a job before accepting it. Admin token required.
- `/api/upload` is unauthenticated (LAN customers) but rate-limited
  (30 files / 5 min / IP) and size-capped (50 MB, magic-byte checked).

## Transport

- JSON/urlencoded bodies capped at 256 KB.
- Headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  and a CSP tuned for pdf.js plus `blob:` in `frame-src`/`object-src` for the
  file preview's native PDF viewer. `X-XSS-Protection` is deliberately not set.
- CORS is dev-only (`DEV_CORS_ORIGIN`, default `http://localhost:3000`).

## Reporting

Pre-launch, no bug-bounty. File an issue or contact the maintainer directly.
