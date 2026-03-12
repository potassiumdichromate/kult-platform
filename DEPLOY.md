# KULT Platform — Render Deployment Guide

## What you need before pushing

### 1. External accounts (Render doesn't provide these)

| Service | Purpose | Free tier? |
|---|---|---|
| [MongoDB Atlas](https://cloud.mongodb.com) | Telemetry service storage | ✅ M0 free cluster |
| [0G Network](https://0g.ai) | Blockchain RPC + decentralized model storage | Check docs |
| Ethereum wallet (for settlement) | Signs on-chain settlement transactions | — |

---

## Step-by-step deploy

### Step 1 — Prep your repo

```bash
# From kult-platform/ root
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR_ORG/kult-platform.git
git push -u origin main
```

### Step 2 — MongoDB Atlas setup

1. Go to [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create a **free M0** cluster (Oregon region to match Render)
3. Add a database user with password
4. Allow access from `0.0.0.0/0` (Render IPs are dynamic)
5. Copy your connection string:
   ```
   mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/kult_telemetry
   ```
6. Keep this — you'll paste it in Step 5

### Step 3 — Connect repo to Render

1. Go to [render.com](https://render.com) → **New** → **Blueprint**
2. Connect your GitHub account
3. Select the `kult-platform` repo
4. Render detects `render.yaml` automatically → click **Apply**
5. Render will create all services and the PostgreSQL + Redis instances

### Step 4 — Wait for first build

First build takes **10-20 minutes** (downloads all npm packages, compiles TypeScript, runs Prisma generate for each service).

**What happens automatically:**
- ✅ PostgreSQL `kult_platform` database created
- ✅ Redis instance created
- ✅ `JWT_SECRET` and `INTERNAL_API_SECRET` auto-generated (shared across services via envVarGroup)
- ✅ `ENCRYPTION_KEY` for wallet service auto-generated
- ✅ Each Prisma service runs `prisma migrate deploy` on startup
- ✅ All services connect to the same PostgreSQL and Redis

### Step 5 — Fill in the `sync: false` env vars

After all services are deployed, go to each service in the Render dashboard and fill in the missing env vars. Here's the wiring:

#### kult-gateway
| Env Var | Value (copy from Render dashboard) |
|---|---|
| `AGENT_REGISTRY_SERVICE_URL` | `https://kult-agent-registry.onrender.com` |
| `MODEL_REGISTRY_SERVICE_URL` | `https://kult-model-registry.onrender.com` |
| `AVATAR_AI_SERVICE_URL` | `https://kult-avatar-ai.onrender.com` |
| `ARENA_SERVICE_URL` | `https://kult-arena.onrender.com` |
| `RANKING_SERVICE_URL` | `https://kult-ranking.onrender.com` |
| `TOURNAMENT_SERVICE_URL` | `https://kult-tournament.onrender.com` |
| `TELEMETRY_SERVICE_URL` | `https://kult-telemetry.onrender.com` |
| `WALLET_SERVICE_URL` | `https://kult-wallet.onrender.com` |
| `AI_TRANSACTION_SERVICE_URL` | `https://kult-ai-transaction.onrender.com` |
| `SETTLEMENT_SERVICE_URL` | `https://kult-settlement.onrender.com` |

#### kult-telemetry
| Env Var | Value |
|---|---|
| `MONGODB_URI` | `mongodb+srv://USER:PASS@cluster0.xxx.mongodb.net/kult_telemetry` |

#### kult-avatar-ai
| Env Var | Value |
|---|---|
| `AI_WARZONE_SERVICE_URL` | URL of your existing AI Warzone service |
| `AI_WARZONE_API_KEY` | Your Warzone API key |
| `MODEL_REGISTRY_SERVICE_URL` | `https://kult-model-registry.onrender.com` |

#### kult-settlement
| Env Var | Value |
|---|---|
| `SETTLER_PRIVATE_KEY` | Private key of wallet that signs settlements on 0G Mainnet |
| `ARENA_SERVICE_URL` | `https://kult-arena.onrender.com` |
| `TOURNAMENT_SERVICE_URL` | `https://kult-tournament.onrender.com` |

#### kult-blockchain envVarGroup
After deploying smart contracts to 0G Mainnet (see `contracts/scripts/deploy.ts`):
- Update `AGENT_REGISTRY_CONTRACT`, `GAME_ECONOMY_CONTRACT`, `TREASURY_CONTRACT`, `SETTLEMENT_CONTRACT`
- These are in the **kult-blockchain** env group → edit once, propagates to all services

#### Remaining inter-service URLs
Wire the remaining service URLs following the same pattern as gateway above. Each service's `.env.example` lists which URLs it needs.

### Step 6 — Deploy smart contracts

```bash
cd contracts
cp .env.example .env
# Fill in PRIVATE_KEY and RPC_URL in .env

npm install
npx hardhat run scripts/deploy.ts --network zerog
# Copy contract addresses from output → update kult-blockchain envVarGroup in Render
```

### Step 7 — Verify health

```bash
# Run from repo root after setting RENDER_API_KEY
npx ts-node scripts/health-check.ts
```

Or manually hit each health endpoint:
```
https://kult-gateway.onrender.com/health
https://kult-agent-registry.onrender.com/health
... etc
```

---

## Prisma migrations

Each Prisma-based service runs `prisma migrate deploy` automatically on startup.

To create a new migration locally and push:
```bash
# Example for agent-registry-service
cd services/agent-registry-service
npx prisma migrate dev --name add_new_field
# Commit the generated migration files
git add prisma/migrations/
git commit -m "add migration: add_new_field to agent-registry"
git push
# Render redeploys → migration runs on next startup
```

---

## Cost breakdown

| Resource | Plan | Monthly |
|---|---|---|
| kult-gateway | Starter | $7 |
| kult-agent-registry | Starter | $7 |
| kult-model-registry | Starter | $7 |
| kult-avatar-ai | **Standard** (TF.js needs 2GB RAM) | $25 |
| kult-arena | Starter | $7 |
| kult-ranking | Starter | $7 |
| kult-tournament | Starter | $7 |
| kult-telemetry | Starter | $7 |
| kult-wallet | Starter | $7 |
| kult-ai-transaction | Starter | $7 |
| kult-settlement | Starter | $7 |
| PostgreSQL (shared) | Starter | $7 |
| Redis | Starter | $10 |
| **TOTAL** | | **≈ $104/mo** |

**Minimum viable deployment** (skip avatar-ai, telemetry, model-registry initially):
- 8 services + PostgreSQL + Redis = **≈ $66/mo**

---

## Troubleshooting

### Build fails: "Cannot find module @kult/shared"
The workspace build order matters. Verify the Dockerfile runs:
```dockerfile
RUN npm run build -w @kult/shared     # FIRST
RUN npm run build -w @kult/X-service  # THEN the service
```

### Prisma migrate fails on startup
- Check `DATABASE_URL` is set correctly (comes from `kult-postgres` via `fromDatabase`)
- Check PostgreSQL instance is running in Render dashboard
- Check that `prisma/schema.prisma` is in the Docker image (COPY step in Dockerfile)

### Service can't reach another service
- Verify the `_SERVICE_URL` env var is set in the Render dashboard (sync: false vars need manual entry)
- All services are on the same Render region (oregon) — use the `.onrender.com` public URLs
- On paid Render plans, you can use private networking (internal hostnames)

### Avatar AI service crashes
- It needs the **Standard** plan (2GB RAM) for TensorFlow.js
- Check that `AI_WARZONE_SERVICE_URL` is set and the Warzone service is running

### Wallet encryption issues
- `ENCRYPTION_KEY` is auto-generated by Render — do NOT change it after first deploy
- If you rotate it, all encrypted hot wallets become unreadable

---

## Environment variable reference

See each service's `.env.example` for the full list of supported variables.

| Variable | Where set | Description |
|---|---|---|
| `JWT_SECRET` | envVarGroup `kult-shared-auth` (auto-generated) | Signs JWTs |
| `INTERNAL_API_SECRET` | envVarGroup `kult-shared-auth` (auto-generated) | Service-to-service auth header |
| `DATABASE_URL` | fromDatabase `kult-postgres` | PostgreSQL connection string |
| `REDIS_URL` | fromService `kult-redis` | Redis connection string |
| `ENCRYPTION_KEY` | kult-wallet (auto-generated) | AES-256-GCM key for hot wallets |
| `SETTLER_PRIVATE_KEY` | kult-settlement (manual) | 0G Mainnet signing key |
| `MONGODB_URI` | kult-telemetry (manual) | MongoDB Atlas URI |
| `AI_WARZONE_SERVICE_URL` | kult-avatar-ai (manual) | Your existing AI Warzone endpoint |
| Contract addresses | envVarGroup `kult-blockchain` (manual after deploy) | 0G Mainnet contract addresses |
