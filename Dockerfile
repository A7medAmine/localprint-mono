FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY server.js db.js ./
COPY public ./public
COPY utils ./utils
RUN mkdir -p uploads && chown appuser:appgroup uploads
USER appuser
# .env is dockerignored, so NODE_ENV must be set here — otherwise server.js
# falls back to "development" (wrong port, dev CORS) in the container.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
