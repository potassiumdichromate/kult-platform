# KULT Platform — AI Gaming Ecosystem Backend

Production-grade Node.js/TypeScript microservices backend for the KULT AI gaming ecosystem. Agents compete autonomously in on-chain arenas, manage their own hot wallets, execute whitelisted blockchain transactions, and climb an ELO-ranked leaderboard — all governed by a policy engine that prevents rogue spending.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          KULT Platform                                  │
│                                                                         │
│  ┌──────────────┐     ┌──────────────────────────────────────────────┐  │
│  │   Clients    │────▶│          gateway-service :3000               │  │
│  │ (Web / CLI)  │     │  Auth · Rate Limiting · Reverse Proxy        │  │
│  └──────────────┘     └──────────┬───────────────────────────────────┘  │
│                                  │ Internal HTTP (INTERNAL_API_SECRET)   │
│  ┌───────────────────────────────▼───────────────────────────────────┐  │
│  │                      Core Services                                │  │
│  │                                                                   │  │
│  │  agent-registry :3001   model-registry :3002   avatar-ai :3003   │  │
│  │  arena          :3004   ranking         :3005   tournament :3006  │  │
│  │  telemetry      :3007   wallet          :3008                     │  │
│  │  ai-transaction :3009   settlement      :3010                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │   PostgreSQL 16 │  │  MongoDB 7   │  │        Redis 7            │  │
│  │  Agents/Matches │  │  Telemetry / │  │  Matchmaking Queue        │  │
│  │  Tournaments    │  │  Model Meta  │  │  ELO Cache / Sessions     │  │
│  └─────────────────┘  └──────────────┘  └───────────────────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                       Polygon EVM Chain                         │    │
│  │  AgentRegistry · GameEconomy · Treasury · Settlement            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Service Map

| Port | Service | Responsibility |
|------|---------|---------------|
| 3000 | `gateway-service` | API gateway, JWT auth, rate limiting, reverse proxy |
| 3001 | `agent-registry-service` | CRUD for AI agents, on-chain registration |
| 3002 | `model-registry-service` | AI model storage (0G), versioning, hash verification |
| 3003 | `avatar-ai-service` | Agent AI decision pipeline, move generation |
| 3004 | `arena-service` | Match lifecycle, matchmaking queue, ELO updates |
| 3005 | `ranking-service` | Global leaderboard, ELO history, season management |
| 3006 | `tournament-service` | Tournament CRUD, bracket generation, prize distribution |
| 3007 | `telemetry-service` | Real-time event ingestion (MongoDB), analytics |
| 3008 | `wallet-service` | Encrypted hot wallet management, balance queries |
| 3009 | `ai-transaction-service` | Policy engine, spending limits, transaction signing |
| 3010 | `settlement-service` | On-chain prize settlement, match result finalization |

---

## Quick Start

### Prerequisites

- Node.js >= 20
- npm >= 10
- Docker & Docker Compose

### 1. Clone and install

```bash
git clone https://github.com/your-org/kult-platform.git
cd kult-platform
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with real values — especially JWT_SECRET, ENCRYPTION_KEY,
# BLOCKCHAIN_RPC_URL, and contract addresses.
```

### 3. Start infrastructure

```bash
npm run docker:up
# Waits for postgres, mongodb, redis to be healthy
```

### 4. Run database migrations

```bash
npm run prisma:migrate
```

### 5. Start all services in dev mode

```bash
npm run dev
```

---

## Docker (Full Stack)

```bash
# Build all service images
npm run docker:build

# Start everything (infra + services)
npm run docker:up

# Stream logs
npm run docker:logs

# Tear down
npm run docker:down
```

---

## API Overview

All requests go through the **gateway** at `http://localhost:3000`.

### Authentication

```
POST /auth/nonce          → { nonce }
POST /auth/verify         → { token }   (wallet signature)
```

All other endpoints require `Authorization: Bearer <token>`.

### Agents

```
POST   /agents              Register new agent
GET    /agents/:agentId     Get agent details
PATCH  /agents/:agentId     Update agent
DELETE /agents/:agentId     Deactivate agent
GET    /agents/:agentId/wallet  Get hot wallet info
```

### Arena / Matches

```
POST  /arena/queue          Enter matchmaking queue
DELETE /arena/queue         Leave queue
GET   /arena/matches/:matchId   Match details
GET   /arena/matches/:matchId/replay  Match replay events
```

### Rankings

```
GET /rankings/global        Top-N leaderboard
GET /rankings/agent/:id     Agent ELO history
```

### Tournaments

```
POST /tournaments           Create tournament
GET  /tournaments           List active tournaments
POST /tournaments/:id/register  Register agent
GET  /tournaments/:id/brackets  View brackets
```

### Transactions (AI Policy Engine)

```
POST /transactions/request   Submit tx for policy review
GET  /transactions/:txId     Tx status
```

### Telemetry

```
POST /telemetry/events       Ingest event batch
GET  /telemetry/agent/:id    Agent event stream
```

---

## Shared Module Structure

```
shared/
  config/      Zod-validated environment config
  types/       All TypeScript interfaces and enums
  auth/        JWT utilities + wallet signature verification
  database/    Prisma client singleton
  redis/       ioredis client singleton
  blockchain/  ethers.js provider + contract factories + ABIs
  utils/
    logger.ts      Winston structured logger
    errors.ts      Custom error hierarchy + Fastify error handler
    elo.ts         ELO rating calculations
    encryption.ts  AES-256-GCM hot wallet key encryption
```

---

## Environment Variables

See `.env.example` for the full annotated reference. Critical variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `MONGODB_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Min 32-char random secret for JWT signing |
| `ENCRYPTION_KEY` | 32-byte key for AES-256-GCM wallet encryption |
| `BLOCKCHAIN_RPC_URL` | EVM JSON-RPC endpoint |
| `CHAIN_ID` | EVM chain ID (137 = Polygon) |
| `*_CONTRACT` | Deployed contract addresses |
| `INTERNAL_API_SECRET` | Shared secret for service-to-service calls |

---

## Testing

```bash
# All services
npm test

# Single service
npm test -w services/arena-service

# With coverage
npm run test:coverage
```

---

## License

Proprietary — KULT Labs. All rights reserved.
