# DEPLOYMENT — Atba3li Cloud (online)

Multi-tenant SaaS. **One** Node server instance serves every shop
(`shopSlug`-scoped). Uploaded files live on the box's disk (persistent volume),
backed up nightly. Target cost **$6–10/mo**.

## Stack (locked)

| Piece | Choice | Cost |
|---|---|---|
| Postgres + Auth | Supabase **Free** (500 MB DB, 50k MAU) | $0 |
| Node server (`apps/online/server.js`) | One small VPS — Hetzner CX22 / Fly.io shared-1x | ~$5–8 |
| Uploaded files | Local disk on the VPS (persistent volume) | included |
| Backups | Nightly `pg_dump` + `uploads/` tarball → Backblaze B2 / Cloudflare R2 | ~$0–2 |
| Domain + TLS | Cloudflare (free) in front, Caddy on the box for certs | $0 (domain ~$10/yr) |

Headroom: move Supabase to Pro ($25) if MAU/DB outgrow Free.

## Single-instance constraints (read, don't "fix")

These are correct **because there is exactly one server instance**:

- in-memory rate limiter (`@atba3li/shared/http`)
- SSE/`ws` subscriber map keyed by orderId (`statusSubscribers`)
- `setInterval` cleanup jobs (`cleanupOldOrders`)

If the app ever scales out beyond one instance, move these to Postgres/Redis.
Until then they stay in memory — that's the design.

`server.js` already sets `app.set('trust proxy', 1)` because Cloudflare + Caddy
sit in front (correct `req.ip` for the rate limiter). Leave it.

---

## 1. VPS provisioning

Ubuntu 22.04/24.04 LTS on Hetzner CX22 (or Fly.io shared-1x + a volume):

```bash
# non-root operator user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy

# firewall — ssh only; 80/443 go through Cloudflare to Caddy
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (automatic TLS)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Deploy the code (from the monorepo root on your machine):

```bash
# on the VPS, as deploy:
git clone <repo-url> atba3li-mono
cd atba3li-mono
npm ci --workspace @atba3li/online --workspace @atba3li/shared
npm run build -w @atba3li/online
mkdir -p apps/online/uploads
```

## 2. Environment (`apps/online/.env`)

Secrets only. Shape (not real values):

```dotenv
NODE_ENV=production
# PORT defaults to 3000 in production; HOST defaults to 127.0.0.1 (Caddy proxies to it)

# Supabase project (Project Settings → API)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=<service_role key — server-side only>

# Super-admin login for the /platform-admin console (create/manage stores).
# Generate the hash: node scripts/admin-password.js "<password>" --username admin
PLATFORM_ADMIN_USERNAME=admin
PLATFORM_ADMIN_PASSWORD_HASH=scrypt:16384:8:1:<salt>:<hash>

# Optional machine bearer for the same /api/admin/* endpoints (scripts, curl, CI)
PLATFORM_ADMIN_TOKEN=<long random string>
```

The frontend (built at deploy time) reads `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` for customer accounts — set those in the **build**
environment (CI or shell) before `npm run build`, not at runtime.

Shop-sync auth is **per-shop**, not a global secret: each shop's token is minted
into `shops.token_hash` by `node apps/online/scripts/create-shop.js "<Name>" --host https://your-domain.com`.
The desktop app stores that token in its own Cloud Sync settings.

## 3. Supabase project + migrations

1. Create a Supabase project; copy the URL / service_role key into `.env`
   (`node scripts/setup-env.js` prompts for both).
2. Apply the schema — `apps/online/supabase/migrations/` is the source of truth
   (see its README):

   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

   On a scratch/pre-launch project `supabase db reset` replays `001…00N` cleanly.
3. RLS is enabled on every table (see `001_initial_schema.sql`); the server uses
   the service-role key, so it bypasses RLS — never expose that key client-side.
4. Provision the first shop: `node apps/online/scripts/create-shop.js "<Name>" --host https://your-domain.com`.

## 4. Caddyfile (`/etc/caddy/Caddyfile`)

```
your-domain.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
```

Caddy auto-obtains/renews the TLS cert. Keep DNS **proxied** through Cloudflare
(orange cloud) so the origin IP stays hidden; Caddy handles TLS origin-side.

## 5. systemd unit (`/etc/systemd/system/atba3li.service`)

```ini
[Unit]
Description=Atba3li Cloud (online)
After=network.target

[Service]
User=deploy
WorkingDirectory=/opt/atba3li-mono/apps/online
EnvironmentFile=/opt/atba3li-mono/apps/online/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now atba3li
sudo systemctl status atba3li
```

## 6. Nightly backup (non-optional — files are on a pet box)

`uploads/` is the ONLY copy of customer files. Back it up every night to
Cloudflare R2 (free) or Backblaze B2:

```bash
sudo tee /etc/cron.d/atba3li-backup <<'EOF'
30 2 * * * deploy /opt/atba3li-mono/scripts/backup.sh >>/var/log/atba3li-backup.log 2>&1
EOF
```

`scripts/backup.sh` (install `rclone` or use `aws s3` against R2/B2):

```bash
#!/usr/bin/env bash
set -euo pipefail
DATE=$(date +%F)
DEST="r2:bucket/atba3li/$DATE"

# Postgres (Supabase) logical dump
pg_dump "$SUPABASE_DB_URL" -f "/tmp/atba3li-$DATE.sql"

# uploads tarball
tar -C /opt/atba3li-mono/apps/online -czf "/tmp/atba3li-uploads-$DATE.tar.gz" uploads

rclone copy /tmp/atba3li-$DATE.sql "$DEST/" && rm /tmp/atba3li-$DATE.sql
rclone copy /tmp/atba3li-uploads-$DATE.tar.gz "$DEST/" && rm /tmp/atba3li-uploads-$DATE.tar.gz

# retention: keep 30 days
rclone delete --min-age 30d "r2:bucket/atba3li"
```

`SUPABASE_DB_URL` comes from Supabase → Project Settings → Database →
Connection string. Test a restore at least once before go-live.

## 7. Cloudflare

- DNS record: `your-domain.com` → VPS IP, **proxied**.
- SSL/TLS mode: **Full** (Caddy terminates the origin cert).
- Page rules: cache `/assets/*` (the Vite bundle is content-hashed); never
  cache `/api/*`.

## 8. Optional — Docker

`apps/online/Dockerfile` is a multi-stage image (root build context, non-root
user, `VOLUME /app/apps/online/uploads`) for a containerized alternative:

```bash
docker build -f apps/online/Dockerfile -t atba3li/online .
docker run -d --name atba3li-online -p 3000:3000 \
  -v atba3li-uploads:/app/apps/online/uploads \
  --env-file apps/online/.env \
  atba3li/online
```

Either bare-VPS (sections 1–7, the recommended $6–10/mo path) or Docker
(section 8) — not both. The old `nixpacks.toml` (Railway) was removed.

### Dockploy

- Build context must be the **repo root**, Dockerfile path
  `apps/online/Dockerfile` (Dockploy's "Build Path"/"Docker File" settings) —
  same requirement as the raw `docker build -f` command above.
- Runtime env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
  `PLATFORM_ADMIN_PASSWORD_HASH`) go in Dockploy's **Environment** tab.
- If customer accounts are enabled, `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` must ALSO be set as Dockploy **Build Args** (Vite
  inlines them at `vite build` time, not at container start) — setting them as
  runtime env only has no effect on the built frontend.
- Mount a volume at `/app/apps/online/uploads` (Dockploy "Volumes") — otherwise
  uploaded files are lost on every redeploy.
- Map the container's port **3000** to your domain; `HOST` is already forced
  to `0.0.0.0` in the image for this (see Dockerfile comment) — don't override
  it back to `127.0.0.1` in Dockploy's env, it'll break routing.

## Verify before go-live

- `apps/online/checkEnv.js` list matches the env table above.
- `supabase db push` applies cleanly on a scratch project.
- A test upload survives a server restart (files on the volume/disk).
- Backup cron ran once and the R2/B2 bucket holds a restorable `uploads/` tarball.

---

## 9. Vercel (trial only — not the production path)

Config lives at the repo root (`vercel.json`):

- `rootDirectory: "apps/online"`, `buildCommand: "npm run build"`,
  `outputDirectory: "dist"` — Vercel serves the built SPA statically.
- `installCommand: "npm ci --workspace @atba3li/online --workspace
  @atba3li/shared"` — deliberately skips the desktop workspace so its
  Electron `postinstall` never runs on Vercel.
- `apps/online/api/index.js` exports the Express app; `server.js` skips
  `app.listen()` when `process.env.VERCEL === "1"` and points `UPLOADS_DIR` at
  `os.tmpdir()` (the serverless filesystem is read-only otherwise).
- `rewrites` send every non-`/api/` path to `/index.html` (SPA routing).

To deploy:

```bash
npm i -g vercel
vercel            # link the repo, import the Vercel env vars below
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_KEY
vercel env add PLATFORM_ADMIN_TOKEN
vercel --prod
```

Then run migrations against the same Supabase project
(`supabase link && supabase db push`) and provision shops with
`node apps/online/scripts/create-shop.js`.

**Hard limits — why this is trial-only:**

- **Uploads are ephemeral.** `os.tmpdir()` is throwaway: uploaded customer
  files vanish when the lambda instance is recycled, so upload→sync-to-desktop
  is not reliable. Real deployments use the VPS path (sections 1–7) or move
  uploads to Vercel Blob / S3.
- **Request body cap.** Vercel's serverless body limit (~4.5 MB on Hobby)
  rejects the large PDFs the app is designed to accept.
- **SSE/`ws` + timers don't survive.** In-memory `statusSubscribers`, the
  rate limiter, and `cleanupOldOrders` are per-instance and frozen between
  requests, so live status push and daily cleanup won't work as designed.
- **Single-instance assumptions** (see "Single-instance constraints" above)
  do not hold on a serverless platform that may spin up many instances.

Use Vercel to preview the frontend and smoke-test API routes. For a live shop,
use the VPS setup.
