# =============================================================================
# KULT Platform — Arena Service (ELO Matchmaking)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/arena-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/arena-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/arena-service/dist         ./services/arena-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/arena-service/package.json ./services/arena-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/arena-service/prisma       ./services/arena-service/prisma

USER nodejs

EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3004}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/arena-service/prisma/schema.prisma && node services/arena-service/dist/index.js"]
