# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Monorepo build. The build context is the repo ROOT, not apps/online — the
# online server imports @localprint/shared, which only resolves as a workspace.
#
#   docker build -f apps/online/Dockerfile -t localprint/online .
#
# Workspaces are installed selectively (--workspace) so the desktop app's
# Electron/native postinstall never runs inside the container.
# ─────────────────────────────────────────────────────────────────────────────

# ---- build stage: bundle the Vite frontend ---------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/online/package.json ./apps/online/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --workspace @localprint/online --workspace @localprint/shared

COPY packages/shared ./packages/shared
COPY apps/online ./apps/online
RUN npm run build -w @localprint/online

# ---- runtime stage: slim, non-root, uploads as a volume ---------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/online/package.json ./apps/online/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev --workspace @localprint/online --workspace @localprint/shared \
  && npm cache clean --force

# Shared workspace source (server imports its .js modules) + the server itself.
COPY packages/shared ./packages/shared
COPY apps/online/server.js apps/online/db.js apps/online/checkEnv.js ./apps/online/
COPY apps/online/utils ./apps/online/utils
COPY apps/online/public ./apps/online/public
COPY --from=builder /app/apps/online/dist ./apps/online/dist

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /app/apps/online/uploads \
  && chown -R appuser:appgroup /app
USER appuser
WORKDIR /app/apps/online

# Uploaded files live on this volume (pet box — back them up nightly, see
# DEPLOYMENT.md). Declaring it keeps the data across container restarts.
VOLUME ["/app/apps/online/uploads"]
EXPOSE 3000
CMD ["node", "server.js"]
