# =============================================================================
# KULT Platform — Agent Registry Service
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

# Generate Prisma client (schema at services/agent-registry-service/prisma/schema.prisma)
RUN cd services/agent-registry-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/agent-registry-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/agent-registry-service/dist         ./services/agent-registry-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/agent-registry-service/package.json ./services/agent-registry-service/package.json

# Prisma schema required for `prisma migrate deploy` at startup
COPY --from=builder --chown=nodejs:nodejs /app/services/agent-registry-service/prisma ./services/agent-registry-service/prisma

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/agent-registry-service/prisma/schema.prisma && node services/agent-registry-service/dist/index.js"]
