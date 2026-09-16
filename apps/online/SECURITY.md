# Security model — Atba3li online

Multi-tenant Express service (`server.js`) backed by Supabase (Postgres + Auth).
Each shop is a tenant keyed by `shopSlug`. Customers upload files from their
phone; shops pull orders down to their desktop app.

## Trust boundaries

| Caller | Authenticates with | Scope |
|---|---|---|
| Guest customer | None; per-upload delete token | Upload / track / delete their own order under one shop |
| Signed-in customer | Supabase JWT (ES256, verified locally via JWKS) | Same, plus orders linked to their account |
| Shop (desktop app) | Per-shop bearer token (`shops.token_hash`, sha256) | Pull pending orders, ack/reject, push settings — its own shop only |
| Platform super-admin (console) | Username + password → httpOnly session cookie (scrypt hash in `PLATFORM_ADMIN_PASSWORD_HASH`) | Create shops, rotate shop tokens, rename/deactivate |
| Platform admin (scripts) | `PLATFORM_ADMIN_TOKEN` bearer | Same, for curl/CI |

## Shop provisioning

- `POST /api/admin/shops` → `{ slug, token }` (token shown **once**).
- `POST /api/admin/shops/:id/rotate-token` → new token, old one dies immediately.
- `GET /api/admin/shops`, `PATCH /api/admin/shops/:id` (rename / slug / isActive).
- `shops.is_active = false` → `resolveShopBySlug` 404s and `requireShopToken`
  403s.

## Super-admin console (`/platform-admin`)

- Login: `POST /api/admin/login` (username + password) sets an **httpOnly,
  SameSite=Strict** session cookie; sessions live in memory for 8h, so a restart
  signs the admin out. Password is stored as a scrypt hash — never plaintext.
- Mutating calls need the per-session CSRF token (`X-CSRF-Token`) issued at
  login, on top of SameSite. `GET` is exempt (read-only).
- Brute force: per-IP limiter (10 logins / 15 min) **and** a per-account lockout
  (5 failures → locked 15 min).
- `PLATFORM_ADMIN_TOKEN` still works as a bearer for scripts; the console itself
  no longer asks anyone to paste it into a page.

## Customer auth resilience

- `requireCustomerAuth` / `optionalCustomerAuth` answer **503** (not 401) when
  Supabase auth is unreachable, so a good session is not thrown away.
- The **public upload** route uses `optionalCustomerAuthLenient`: a
  token-carrying request whose auth can't be verified is downgraded to guest and
  tagged `orders.auth_deferred = true` for later reconciliation. A request with
  no token never touches the auth path.

## Secrets & settings

- `GET /api/s/:shopSlug/settings` is public → allowlist only
  (`PUBLIC_SETTINGS_KEYS`). The shop's desktop app uses `GET /api/shop/settings`
  (shop token) for the full set.
- Shop tokens are stored **hashed** (`shops.token_hash`), never in the `settings`
  KV bag. The server uses the Supabase **service key** (RLS bypass); the anon
  key, if ever shipped to the client, must be paired with strict RLS on
  `orders`, `profiles`, `settings`, `paper_types`, `discount_rules`, `shops`.

## File & order access

- `orders.id` and the per-upload delete token are generated server-side; only
  `sha256(deleteToken)` is stored (`orders.delete_token_hash`).
- `DELETE /api/s/:shopSlug/orders/:id` requires the matching token.
- `GET /api/s/:shopSlug/files/public/:id` refuses `pending_review` / `rejected`
  orders; non-inline types get `Content-Disposition: attachment`.
- Uploads are rate-limited, 50 MB capped, magic-byte checked.

## Transport

- `app.set('trust proxy', 1)` — Cloudflare + the box's reverse proxy sit in front.
- JSON/urlencoded bodies capped at 256 KB.
- Headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  CSP (allows `https://*.supabase.co` for auth). `X-XSS-Protection` not set.
- CORS dev-only (`DEV_CORS_ORIGIN`).

## Single-instance assumptions

The rate limiter, SSE subscriber map, and cleanup `setInterval`s are in-memory —
correct only while there is exactly one server process. See `DEPLOYMENT.md`
(Phase 4) before scaling out.
