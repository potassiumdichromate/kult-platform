# =============================================================================
# KULT Platform — Gateway Service
# Build context: REPO ROOT  ← set in docker-compose.yml and render.yaml
# =============================================================================

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy the full monorepo (.dockerignore strips node_modules, dist, .env etc.)
COPY . .

# Install ALL workspace dependencies (hoisted to root node_modules)
RUN npm ci

# Build shared module first — every service imports from it
RUN npm run build -w @kult/shared

# Build this service
RUN npm run build -w @kult/gateway-service

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Workspace root manifest (npm package resolution needs this)
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

# All hoisted node_modules (kept intact so prisma CLI is available at runtime)
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Shared compiled output
COPY --from=builder --chown=nodejs:nodejs /app/shared/dist         ./shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/shared/package.json ./shared/package.json

# This service compiled output
COPY --from=builder --chown=nodejs:nodejs /app/services/gateway-service/dist         ./services/gateway-service/dist
COPY --from=builder --chown=nodejs:nodejs /app/services/gateway-service/package.json ./services/gateway-service/package.json

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/health || exit 1

CMD ["node", "services/gateway-service/dist/index.js"]
