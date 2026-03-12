# =============================================================================
# KULT Platform — Wallet Service (Hot Wallet + AES-256-GCM key storage)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/wallet-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/wallet-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/wallet-service/dist         ./services/wallet-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/wallet-service/package.json ./services/wallet-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/wallet-service/prisma       ./services/wallet-service/prisma

USER nodejs

EXPOSE 3008

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3008}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/wallet-service/prisma/schema.prisma && node services/wallet-service/dist/index.js"]
