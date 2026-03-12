# =============================================================================
# KULT Platform — Telemetry Service  (MongoDB — no Prisma)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/telemetry-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/telemetry-service/dist         ./services/telemetry-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/telemetry-service/package.json ./services/telemetry-service/package.json

USER nodejs

EXPOSE 3007

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3007}/health || exit 1

CMD ["node", "services/telemetry-service/dist/index.js"]
