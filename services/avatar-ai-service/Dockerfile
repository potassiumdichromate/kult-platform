# =============================================================================
# KULT Platform — Avatar AI Service
# TensorFlow.js native bindings need glibc — use Debian, NOT Alpine
# Build context: REPO ROOT
# =============================================================================

# ── Stage 1: Build (full Debian for TF native toolchain) ─────────────────────
FROM node:20 AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y \
  python3 make g++ libc6-dev \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm ci

RUN npm run build -w @kult/shared
RUN npm run build -w @kult/avatar-ai-service

# ── Stage 2: Runtime (slim Debian — still needs glibc for TF) ─────────────────
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y \
  dumb-init wget libstdc++6 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/sh appuser

COPY --from=builder --chown=appuser:appgroup /app/package.json        ./package.json
COPY --from=builder --chown=appuser:appgroup /app/node_modules        ./node_modules

COPY --from=builder --chown=appuser:appgroup /app/shared/dist         ./shared/dist
COPY --from=builder --chown=appuser:appgroup /app/shared/package.json ./shared/package.json

COPY --from=builder --chown=appuser:appgroup /app/services/avatar-ai-service/dist         ./services/avatar-ai-service/dist
COPY --from=builder --chown=appuser:appgroup /app/services/avatar-ai-service/package.json ./services/avatar-ai-service/package.json

USER appuser

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3003}/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "services/avatar-ai-service/dist/index.js"]
