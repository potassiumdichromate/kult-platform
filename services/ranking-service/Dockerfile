# =============================================================================
# KULT Platform — Ranking Service (ELO + Leaderboard)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/ranking-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/ranking-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/ranking-service/dist         ./services/ranking-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/ranking-service/package.json ./services/ranking-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/ranking-service/prisma       ./services/ranking-service/prisma

USER nodejs

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3005}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/ranking-service/prisma/schema.prisma && node services/ranking-service/dist/index.js"]
