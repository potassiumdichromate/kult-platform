# =============================================================================
# KULT Platform — Tournament Service
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/tournament-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/tournament-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/tournament-service/dist         ./services/tournament-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/tournament-service/package.json ./services/tournament-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/tournament-service/prisma       ./services/tournament-service/prisma

USER nodejs

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3006}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/tournament-service/prisma/schema.prisma && node services/tournament-service/dist/index.js"]
