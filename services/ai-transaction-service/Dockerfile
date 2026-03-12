# =============================================================================
# KULT Platform — AI Transaction Service (Policy Engine)
# Build context: REPO ROOT
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

COPY . .
RUN npm ci

RUN cd services/ai-transaction-service && npx prisma generate && cd /app

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/ai-transaction-service

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

COPY --from=builder --chown=nodejs:nodejs /app/package.json        ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules        ./node_modules

COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=nodejs:nodejs /app/services/ai-transaction-service/dist         ./services/ai-transaction-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/ai-transaction-service/package.json ./services/ai-transaction-service/package.json
COPY --from=builder --chown=nodejs:nodejs /app/services/ai-transaction-service/prisma       ./services/ai-transaction-service/prisma

USER nodejs

EXPOSE 3009

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3009}/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy --schema services/ai-transaction-service/prisma/schema.prisma && node services/ai-transaction-service/dist/index.js"]
