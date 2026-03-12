# =============================================================================
# KULT Platform — Settlement Service (On-chain Anchoring)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/settlement-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/settlement-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/settlement-service/dist         ./services/settlement-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/settlement-service/package.json ./services/settlement-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/settlement-service/prisma       ./services/settlement-service/prisma

USER nodejs

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3010}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/settlement-service/prisma/schema.prisma && node services/settlement-service/dist/index.js"]
