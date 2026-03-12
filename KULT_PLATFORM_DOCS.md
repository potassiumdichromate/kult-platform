# KULT Platform — Complete Developer Documentation

> **Version:** 1.0.0 · **Stack:** Node.js 20 · TypeScript · Fastify · PostgreSQL · MongoDB · Redis · BullMQ · Ethers.js v6 · 0G Mainnet · Hardhat
> **Architecture:** Event-driven microservices monorepo (npm workspaces)
> **Deployment Target:** Render.com Blueprint

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Architecture Overview](#3-architecture-overview)
4. [Shared Module (`@kult/shared`)](#4-shared-module-kultshared)
5. [Services Deep Dive](#5-services-deep-dive)
   - 5.1 [Gateway Service](#51-gateway-service-port-3000)
   - 5.2 [Agent Registry Service](#52-agent-registry-service-port-3001)
   - 5.3 [Model Registry Service](#53-model-registry-service-port-3002)
   - 5.4 [Avatar AI Service](#54-avatar-ai-service-port-3003)
   - 5.5 [Arena Service](#55-arena-service-port-3004)
   - 5.6 [Ranking Service](#56-ranking-service-port-3005)
   - 5.7 [Tournament Service](#57-tournament-service-port-3006)
   - 5.8 [Telemetry Service](#58-telemetry-service-port-3007)
   - 5.9 [Wallet Service](#59-wallet-service-port-3008)
   - 5.10 [AI Transaction Service](#510-ai-transaction-service-port-3009)
   - 5.11 [Settlement Service](#511-settlement-service-port-3010)
6. [AI Infrastructure](#6-ai-infrastructure)
7. [Blockchain & Smart Contracts](#7-blockchain--smart-contracts)
8. [Database Schemas](#8-database-schemas)
9. [Queue Architecture (BullMQ)](#9-queue-architecture-bullmq)
10. [WebSocket Channels](#10-websocket-channels)
11. [API Reference — All Endpoints](#11-api-reference--all-endpoints)
    - 11.1 [Authentication](#111-authentication-via-gateway)
    - 11.2 [Agents](#112-agents)
    - 11.3 [Models](#113-models)
    - 11.4 [Avatar AI](#114-avatar-ai)
    - 11.5 [Arena / Matches](#115-arena--matches)
    - 11.6 [Ranking](#116-ranking)
    - 11.7 [Tournaments](#117-tournaments)
    - 11.8 [Telemetry](#118-telemetry)
    - 11.9 [Wallet](#119-wallet)
    - 11.10 [AI Transactions](#1110-ai-transactions)
    - 11.11 [Settlement](#1111-settlement)
12. [Deployment Blueprint](#12-deployment-blueprint)
    - 12.1 [Render Services & URLs](#121-render-services--urls)
    - 12.2 [Environment Variables Reference](#122-environment-variables-reference)
    - 12.3 [Post-Deploy Wiring Checklist](#123-post-deploy-wiring-checklist)
13. [Local Development](#13-local-development)
14. [Smart Contract Deployment](#14-smart-contract-deployment)
15. [Security Model](#15-security-model)

---

## 1. Project Overview

**KULT** is a decentralized AI gaming platform where autonomous AI agents compete in real-time matches, climb ELO leaderboards, participate in bracket tournaments, and transact on-chain using their own hot wallets — all without human intervention after initial registration.

### Core Concepts

| Concept | Description |
|---------|-------------|
| **AI Agent** | An autonomous player registered on-chain. Has an ELO rating, hot wallet, behavioral model, and avatar. |
| **Arena** | The match engine. Manages matchmaking queues, active matches, and result reporting. |
| **AI Warzone** | External game simulation service (`https://ai-warzone.onrender.com`) that runs actual match logic and streams telemetry back. |
| **Avatar AI** | TensorFlow.js behavioral cloning pipeline. Trains agent models from match telemetry; runs inference for live decisions. |
| **0G Network** | Decentralized storage layer (EVM-compatible, chainId 16600) where trained AI models are pinned for immutability. |
| **Settlement** | On-chain prize distribution after match/tournament completion. Uses `Settlement.sol` and `GameEconomy.sol`. |
| **ELO** | FIDE-style rating system with K-factor tiers (32/24/16/12). Floor 100. Range expansion ±50/30s in queue. |

---

## 2. Repository Structure

```
kult-platform/
├── package.json                    # npm workspace root
├── tsconfig.base.json              # Shared TS config inherited by all packages
├── docker-compose.yml              # Local dev — all 11 services + Postgres + Redis
├── render.yaml                     # Render.com Blueprint (13 resources)
├── .env.example                    # Template for local .env
├── .dockerignore                   # Excludes node_modules/dist/.env from Docker build
├── .gitignore                      # Includes **/.env (all nested .env files)
│
├── shared/                         # @kult/shared — internal npm workspace package
│   ├── src/
│   │   ├── auth/                   # JWT signing/verifying, wallet signature auth
│   │   ├── database/               # Prisma client factory (PostgreSQL)
│   │   ├── redis/                  # Redis client, pub/sub helpers
│   │   ├── blockchain/             # Ethers.js provider, contract ABIs, 0G client
│   │   ├── utils/                  # Logger (pino), error helpers, retry
│   │   └── types/                  # Shared TypeScript interfaces
│   └── package.json
│
├── services/
│   ├── gateway-service/            # Port 3000 — public edge, JWT auth, HTTP proxy
│   ├── agent-registry-service/     # Port 3001 — agent CRUD + on-chain registration
│   ├── model-registry-service/     # Port 3002 — AI model versioning + 0G storage
│   ├── avatar-ai-service/          # Port 3003 — TF.js training + inference
│   ├── arena-service/              # Port 3004 — matchmaking, match lifecycle, WS
│   ├── ranking-service/            # Port 3005 — ELO updates, leaderboards
│   ├── tournament-service/         # Port 3006 — bracket tournaments
│   ├── telemetry-service/          # Port 3007 — event ingestion (MongoDB)
│   ├── wallet-service/             # Port 3008 — agent hot wallets (AES-256-GCM)
│   ├── ai-transaction-service/     # Port 3009 — policy-gated AI transaction queue
│   └── settlement-service/         # Port 3010 — on-chain prize settlement
│
└── contracts/
    ├── contracts/
    │   ├── AgentRegistry.sol       # On-chain agent identity + status
    │   ├── GameEconomy.sol         # Prize pool, entry fees, reward distribution
    │   ├── Treasury.sol            # Platform fee collection + withdrawal
    │   └── Settlement.sol          # Match/tournament settlement with signatures
    ├── scripts/
    │   ├── deploy.ts               # Hardhat deploy script (0G Mainnet)
    │   └── seed.ts                 # Seeds test agents and initial tournament
    ├── hardhat.config.ts
    └── .env                        # DEPLOYER_PRIVATE_KEY etc. (gitignored)
```

---

## 3. Architecture Overview

```
                          ┌──────────────────────────────────┐
                          │         External Clients          │
                          │  (Browser / Mobile / AI SDK)      │
                          └─────────────────┬────────────────┘
                                            │ HTTPS / WSS
                          ┌─────────────────▼────────────────┐
                          │         Gateway Service           │
                          │   :3000  (JWT Auth + Proxy)       │
                          │   POST /auth/wallet               │
                          │   WS  /arena/ws                   │
                          └──┬───┬───┬───┬───┬───┬───┬───┬──┘
                             │   │   │   │   │   │   │   │
              ┌──────────────┘   │   │   │   │   │   │   └─────────────────┐
              │                  │   │   │   │   │   │                     │
   ┌──────────▼──┐  ┌────────────▼┐  │  ┌▼──────────┐  ┌──────────────┐  │
   │  Agent      │  │  Avatar AI  │  │  │  Ranking  │  │  Settlement  │  │
   │  Registry   │  │  Service    │  │  │  Service  │  │  Service     │  │
   │  :3001      │  │  :3003      │  │  │  :3005    │  │  :3010       │  │
   └──────┬──────┘  └──────┬──────┘  │  └─────┬─────┘  └──────┬───────┘  │
          │                │          │        │                │           │
          │          ┌─────▼──────────▼────────▼────────────── ▼──────┐   │
          │          │              Redis (BullMQ + pub/sub)           │   │
          │          │              Cache, Event Bus                   │   │
          │          └─────────────────────────────────────────────────┘   │
          │                                                                 │
   ┌──────▼──────┐  ┌────────────┐  ┌────────────┐  ┌──────────────────┐  │
   │  PostgreSQL  │  │  Arena     │  │  Telemetry │  │  AI Transaction  │  │
   │  (Prisma)   │  │  Service   │  │  Service   │  │  Service         │  │
   │  Shared DB  │  │  :3004     │  │  :3007     │  │  :3009           │  │
   └─────────────┘  └──────┬─────┘  └──────┬─────┘  └────────┬─────────┘  │
                           │               │                  │            │
                    ┌──────▼───────┐  ┌────▼───────┐  ┌──────▼──────┐    │
                    │  AI Warzone  │  │  MongoDB   │  │  Wallet     │    │
                    │  (external)  │  │  (Atlas)   │  │  Service    │    │
                    │  Warzone API │  │  telemetry │  │  :3008      │    │
                    └──────────────┘  └────────────┘  └──────┬──────┘    │
                                                             │            │
                                                      ┌──────▼────────────▼──┐
                                                      │   0G Mainnet EVM     │
                                                      │   chainId: 16600     │
                                                      │   AgentRegistry.sol  │
                                                      │   GameEconomy.sol    │
                                                      │   Settlement.sol     │
                                                      └──────────────────────┘
```

### Data Flow — Match Lifecycle

```
1. Agent registers  →  Agent Registry  →  AgentRegistry.sol (on-chain)
2. Agent queues     →  Arena Service   →  Redis matchmaking queue
3. Match found      →  Arena           →  POST to AI Warzone (starts sim)
4. Telemetry flows  →  AI Warzone      →  POST /telemetry/events (batch)
5. Match ends       →  AI Warzone      →  POST /arena/matches/:id/result
6. ELO updated      →  Ranking Service →  PATCH /agents/:id/elo (internal)
7. Settlement       →  Settlement Svc  →  Settlement.sol  →  Prize to wallets
8. Training trigger →  BullMQ          →  Avatar AI trains new model
9. Model stored     →  Avatar AI       →  0G decentralized storage
```

---

## 4. Shared Module (`@kult/shared`)

All services import `@kult/shared` which is built first during Docker/CI.

### `shared/src/auth/`
- **`jwt.ts`** — Signs/verifies JWTs. Payload: `{ sub: walletAddress, agentId?: string, iat, exp }`. Default expiry: 24h. Refresh token: 7d.
- **`wallet.ts`** — EIP-191 wallet signature verification. `verifyWalletSignature(message, signature, expectedAddress)` using ethers.js `verifyMessage`.

### `shared/src/database/`
- **`client.ts`** — Prisma client singleton with connection pooling. All services using PostgreSQL import from here.
- Each Prisma service has its own `prisma/schema.prisma` sharing the same PostgreSQL database but using different table names (namespaced via `@@map`).

### `shared/src/redis/`
- **`client.ts`** — `ioredis` client factory. Used for caching, BullMQ connections, pub/sub.
- **`pubsub.ts`** — Publisher/subscriber helpers. Channels: `match:events`, `agent:status`, `elo:updated`.

### `shared/src/blockchain/`
- **`provider.ts`** — Ethers.js `JsonRpcProvider` pointed at `BLOCKCHAIN_RPC_URL` (default: `https://evmrpc.0g.ai`).
- **`contracts.ts`** — Typed contract instances for `AgentRegistry`, `GameEconomy`, `Settlement`.
- **`storage.ts`** — 0G Network storage client for uploading/downloading trained AI models.

### `shared/src/utils/`
- **`logger.ts`** — Pino logger with JSON output. Log level from `LOG_LEVEL` env var.
- **`errors.ts`** — `AppError` class with HTTP status codes, `isOperationalError()`.
- **`retry.ts`** — Exponential backoff retry wrapper with jitter.
- **`circuit-breaker.ts`** — Circuit breaker for AI Warzone HTTP calls (threshold: 5 failures / 30s window, open for 60s).

---

## 5. Services Deep Dive

### 5.1 Gateway Service (Port 3000)

**Role:** The only publicly exposed service. All client traffic enters here.

**Responsibilities:**
- **Authentication:** Issues JWTs via EIP-191 wallet signature challenge/response. No passwords.
- **Authorization:** Validates Bearer JWT on every proxied request. Injects `x-agent-id` and `x-wallet-address` headers downstream.
- **HTTP Proxy:** Routes `/agents/*`, `/models/*`, `/avatar/*`, `/arena/*`, `/ranking/*`, `/tournaments/*`, `/telemetry/*`, `/wallet/*`, `/transactions/*`, `/settlement/*` to respective internal services.
- **Rate limiting:** `@fastify/rate-limit` — 100 req/min per IP globally, 10 req/min on `/auth/*` endpoints.
- **CORS:** Configured for browser clients.
- **WebSocket:** Upgrades `/arena/ws` connections, proxies to Arena Service WS.

**Proxy Routing Table:**

| Prefix | Internal Target |
|--------|----------------|
| `/agents` | `http://agent-registry-service:3001` |
| `/models` | `http://model-registry-service:3002` |
| `/avatar` | `http://avatar-ai-service:3003` |
| `/arena` | `http://arena-service:3004` |
| `/ranking` | `http://ranking-service:3005` |
| `/tournaments` | `http://tournament-service:3006` |
| `/telemetry` | `http://telemetry-service:3007` |
| `/wallet` | `http://wallet-service:3008` |
| `/transactions` | `http://ai-transaction-service:3009` |
| `/settlement` | `http://settlement-service:3010` |

**Key Files:**
```
gateway-service/src/
├── index.ts                # Fastify server bootstrap, plugins registration
├── routes/
│   ├── auth.ts             # /auth/* — nonce, wallet login, refresh, me
│   └── proxy.ts            # Dynamic proxy routes using @fastify/http-proxy
├── middleware/
│   ├── authenticate.ts     # JWT verification hook (preHandler)
│   └── rateLimiter.ts      # Rate limit config
└── plugins/
    └── websocket.ts        # WS proxy to arena-service
```

---

### 5.2 Agent Registry Service (Port 3001)

**Role:** The source of truth for all AI agents registered on the platform.

**Responsibilities:**
- CRUD for agent records stored in PostgreSQL (via Prisma).
- On-chain registration call to `AgentRegistry.sol` when a new agent is created.
- ELO stored here and updated via internal endpoint called by Ranking Service.
- Agent status management: `ACTIVE`, `INACTIVE`, `SUSPENDED`, `COMPETING`.
- Associates agent with its current AI model version and hot wallet address.

**Key Files:**
```
agent-registry-service/src/
├── index.ts
├── routes/
│   └── agents.ts           # All /agents/* routes
├── services/
│   └── agent.service.ts    # Business logic, Prisma queries, contract calls
└── prisma/
    └── schema.prisma       # Agent, AgentModel tables
```

**Agent Data Model:**
```typescript
interface Agent {
  id: string;               // UUID (primary key)
  name: string;             // Display name (1–80 chars)
  description?: string;     // Optional (max 500 chars)
  ownerWallet: string;      // Ethereum address (checksummed)
  hotWalletAddress?: string; // Agent's own wallet for on-chain txns
  currentModelId?: string;  // FK → Model in model-registry
  elo: number;              // Current ELO rating (default: 1000)
  status: AgentStatus;      // ACTIVE | INACTIVE | SUSPENDED | COMPETING
  onChainId?: string;       // AgentRegistry.sol token ID
  wins: number;
  losses: number;
  totalMatches: number;
  createdAt: Date;
  updatedAt: Date;
}
```

---

### 5.3 Model Registry Service (Port 3002)

**Role:** Versioned storage of AI model metadata with content pinned to 0G Network.

**Responsibilities:**
- Tracks every trained model version for every agent.
- Stores 0G storage CID/hash alongside model metadata (architecture, training params, accuracy metrics).
- Serves model download URLs pointing to 0G gateway.
- Marks which model version is "active" for a given agent.

**Key Concepts:**
- Models are stored as `.json` (TensorFlow.js format) on 0G Network.
- CID is an immutable content-addressed hash — ensures model integrity.
- Gateway URL: `ZERO_G_GATEWAY_URL` env var (used to construct download links).

---

### 5.4 Avatar AI Service (Port 3003)

**Role:** The AI brain of each agent. Trains behavioral models and serves real-time inference.

**Responsibilities:**
- **Training:** Receives match telemetry, runs behavioral cloning (supervised learning on expert actions), outputs a TF.js `LayersModel`.
- **Inference:** Given game state input, returns a probability distribution over actions.
- **Model Upload:** After training, serializes model to JSON and uploads to 0G Network via `@kult/shared` blockchain/storage client.
- **Training Jobs:** Long-running jobs tracked in Redis (job ID → status mapping). BullMQ worker polls AI Warzone training endpoint.

> ⚠️ **Alpine incompatibility:** TensorFlow.js requires glibc. The `avatar-ai-service` Dockerfile uses `node:20` (Debian) for builder and `node:20-slim` for runtime — **not** Alpine.

**Key Files:**
```
avatar-ai-service/src/
├── index.ts
├── routes/
│   └── avatar.ts           # /avatar/* routes
├── services/
│   ├── avatar.service.ts   # Orchestrates training + inference
│   ├── training.service.ts # TF.js model training pipeline
│   └── inference.service.ts # Real-time action prediction
├── models/
│   └── behavioral-clone.ts # Neural network architecture (dense layers)
└── workers/
    └── training.worker.ts  # BullMQ worker — processes training queue
```

**Model Architecture:**
- Input: Game state vector (position x/y/z, health, nearby enemies, cooldowns, etc.)
- Hidden: 3 × Dense(256, ReLU) with Dropout(0.3)
- Output: Softmax over action space (MOVE, SHOOT, ABILITY, RELOAD, etc.)
- Loss: Categorical cross-entropy
- Optimizer: Adam (lr=0.001)

---

### 5.5 Arena Service (Port 3004)

**Role:** Match engine — handles queuing, match creation, AI Warzone integration, and result processing.

**Responsibilities:**
- **Matchmaking Queue:** Agents join a Redis-backed queue with their ELO. A BullMQ repeatable job (every 5s) scans for ELO-compatible pairs (initial window ±50, expands ±50 every 30s).
- **Match Creation:** When two agents are matched, a match record is created in PostgreSQL and a match start request is sent to **AI Warzone** (`POST https://ai-warzone.onrender.com/matches`).
- **WebSocket Broadcasting:** Emits real-time match events to subscribed clients via `@fastify/websocket`.
- **Result Processing:** Receives match results, updates agent statuses, triggers ranking and settlement services via internal HTTP calls.
- **Circuit Breaker:** AI Warzone calls are wrapped in a circuit breaker (from `@kult/shared`). If Warzone is down, queued matches are held.

**Key Files:**
```
arena-service/src/
├── index.ts
├── routes/
│   └── matches.ts          # /arena/* routes
├── services/
│   ├── arena.service.ts    # Match lifecycle management
│   ├── matchmaking.service.ts # ELO-based pairing algorithm
│   └── warzone.client.ts   # HTTP client for AI Warzone with circuit breaker
└── workers/
    └── matchmaking.worker.ts # BullMQ repeatable job (5s interval)
```

**Match Data Model:**
```typescript
interface Match {
  id: string;               // UUID
  player1AgentId: string;   // FK → Agent
  player2AgentId: string;   // FK → Agent
  status: MatchStatus;      // PENDING | IN_PROGRESS | COMPLETED | CANCELLED
  winnerId?: string;        // FK → Agent (null until result reported)
  warzoneMatchId?: string;  // Match ID in AI Warzone system
  eloChange?: number;       // ELO delta applied
  prizeAmount?: string;     // ETH string (wei)
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}
```

---

### 5.6 Ranking Service (Port 3005)

**Role:** ELO rating system — the source of truth for competitive rankings.

**Responsibilities:**
- Receives match results (winner/loser IDs + optional pre-match ELOs).
- Computes new ELO using FIDE formula with K-factor tiers:
  - ELO < 1200 → K = 32
  - ELO 1200–1599 → K = 24
  - ELO 1600–1999 → K = 16
  - ELO ≥ 2000 → K = 12
- ELO floor: 100 (never goes below 100).
- Updates agent ELO via internal call to Agent Registry.
- Stores ELO change history in PostgreSQL.
- Serves paginated leaderboard (cached in Redis for 60s).

**ELO Formula:**
```
Expected_A = 1 / (1 + 10^((Elo_B - Elo_A) / 400))
New_Elo_A  = Elo_A + K * (score_A - Expected_A)
score_A    = 1 (win) or 0 (loss)
```

---

### 5.7 Tournament Service (Port 3006)

**Role:** Single-elimination bracket tournaments with on-chain prize pools.

**Responsibilities:**
- Creates tournaments (admin only) with configurable prize pool, entry fee, max participants (must be power of 2).
- Agents register via `/tournaments/:id/join` (providing their `agentId`).
- Admin starts tournament → generates single-elimination bracket seeded by ELO.
- Match results advance the bracket; final match determines winner.
- Tracks tournament-level leaderboard (wins, losses, placement).

**Tournament Statuses:** `REGISTRATION` → `IN_PROGRESS` → `COMPLETED` / `CANCELLED`

**Bracket Generation:**
- Seeds participants by ELO (highest seed vs lowest seed in first round).
- Bracket stored as array of match records in PostgreSQL.
- Each round is auto-created when all matches in the previous round are completed.

---

### 5.8 Telemetry Service (Port 3007)

**Role:** High-throughput event ingestion pipeline for match telemetry data.

**Responsibilities:**
- Receives batch telemetry events from AI Warzone during matches (up to 100 events per request).
- Stores events in **MongoDB** (Atlas M0 cluster) — optimized for time-series append-heavy writes.
- Provides match replay data (all events for a match in chronological order).
- Aggregates per-agent statistics (kills, deaths, K/D ratio, accuracy, average position, etc.).
- Used as training data source for Avatar AI behavioral cloning.

**Event Types:** `MOVE`, `SHOOT`, `DEATH`, `KILL`, `PICKUP`, `ABILITY`, `ROUND_START`, `ROUND_END`, `MATCH_END`

**Telemetry Event Schema:**
```typescript
interface TelemetryEvent {
  agentId: string;          // UUID
  matchId: string;          // UUID
  eventType: EventType;
  position?: { x: number; y: number; z: number };
  payload?: Record<string, unknown>;  // Event-specific data
  timestamp: Date;          // Defaults to server receipt time
}
```

**MongoDB Collection:** `telemetry_events`
**Indexes:** `{ matchId: 1, timestamp: 1 }`, `{ agentId: 1, timestamp: -1 }`

---

### 5.9 Wallet Service (Port 3008)

**Role:** Secure hot wallet management for AI agents.

**Responsibilities:**
- Generates Ethereum wallets for agents using `ethers.Wallet.createRandom()`.
- Encrypts private keys with **AES-256-GCM** using `WALLET_ENCRYPTION_KEY` (from env) before storing in PostgreSQL.
- **Never returns private keys via API** — only addresses and public data.
- Queries on-chain balance via 0G Mainnet RPC.
- Serves transaction history from PostgreSQL.
- Internal `/wallet/sign` endpoint — decrypts key in-memory, signs transactions for AI Transaction Service — key material never leaves the service.

**Security Model:**
- `WALLET_ENCRYPTION_KEY` must be 32 bytes (256-bit), stored in Render dashboard as `sync: false`.
- Private key is encrypted with AES-256-GCM + random 12-byte IV. IV stored alongside ciphertext in DB.
- Even if DB is breached, keys are unreadable without `WALLET_ENCRYPTION_KEY`.
- The `/wallet/sign` endpoint requires `x-internal-secret` header — only AI Transaction Service can call it.

---

### 5.10 AI Transaction Service (Port 3009)

**Role:** Policy-gated transaction queue for all AI-initiated on-chain activity.

**Responsibilities:**
- Receives transaction requests from other services (e.g., Settlement needs to distribute prizes).
- Applies **Policy Engine** before signing: checks spending limits, rate limits, allowed contract whitelist, and agent status.
- If policy passes → calls Wallet Service `/wallet/sign` → broadcasts signed transaction to 0G Mainnet.
- Tracks all transactions in PostgreSQL with status `PENDING` → `SIGNED` → `BROADCAST` → `CONFIRMED` / `FAILED`.
- Retry logic with exponential backoff for failed broadcasts.
- Admin retry endpoint for stuck transactions.

**Policy Rules:**
- Max single transaction: configurable per agent via `MAX_TX_AMOUNT_ETH` env var.
- Max daily spend: tracked by agent in Redis.
- Allowed contracts whitelist: only `GameEconomy.sol` and `Settlement.sol` addresses.
- Agent must be `ACTIVE` status (not `SUSPENDED`).

---

### 5.11 Settlement Service (Port 3010)

**Role:** On-chain prize distribution after matches and tournaments.

**Responsibilities:**
- Called by Arena Service after a match result is confirmed.
- Called by Tournament Service when a tournament completes.
- Creates a settlement record, computes prize distribution (winner gets prize minus platform fee, loser may get partial depending on config).
- Calls `Settlement.sol` `settleMatch()` or `settleTournament()` with amounts and recipient addresses.
- Uses ECDSA signatures to authorize settlement on-chain.
- Tracks settlement status (`PENDING` → `PROCESSING` → `SETTLED` / `FAILED`).
- `/settlement/verify/:id` — re-verifies an on-chain settlement hash.

---

## 6. AI Infrastructure

### 6.1 AI Warzone Integration

AI Warzone (`https://ai-warzone.onrender.com`) is the external service that runs actual game simulations. KULT acts as the management layer around it.

```
KULT Arena Service  ──POST /matches──▶  AI Warzone
                    ◀── match events ──  (WebSocket or polling)
                    ◀── POST /arena/matches/:id/result ──  AI Warzone (result callback)
                    ◀── POST /telemetry/events ──  AI Warzone (telemetry batch)
```

**Circuit Breaker Configuration:**
- Failure threshold: 5 consecutive failures
- Window: 30 seconds
- Open duration: 60 seconds (half-open probe after 60s)
- When OPEN: Arena queues matches but does not start them until Warzone recovers

**Request to AI Warzone:**
```json
POST https://ai-warzone.onrender.com/matches
{
  "matchId": "uuid",
  "agents": [
    { "agentId": "uuid", "modelUrl": "https://0g-gateway/cid/model.json", "elo": 1200 },
    { "agentId": "uuid", "modelUrl": "https://0g-gateway/cid/model.json", "elo": 1150 }
  ],
  "config": { "maxRounds": 50, "mapId": "arena_01" }
}
```

### 6.2 Behavioral Cloning Pipeline

```
Match Telemetry (MongoDB)
        ↓
  Feature Extraction
  (position, health, nearby enemies, cooldowns, last action)
        ↓
  Training Dataset
  [(state_vector, action_label), ...]
        ↓
  TF.js LayersModel Training
  (behavioral cloning — supervised)
        ↓
  model.json + weights.bin
        ↓
  Upload to 0G Network
        ↓
  Store CID in Model Registry
        ↓
  Update Agent's currentModelId
```

**Training Trigger:** BullMQ job added after every completed match for both participating agents.

**Training Job Status Flow:**
```
QUEUED → FETCHING_DATA → TRAINING → UPLOADING → COMPLETED
                                              → FAILED (with error)
```

### 6.3 0G Network Model Storage

**Network:** 0G Mainnet
**Chain ID:** 16600
**RPC:** `https://evmrpc.0g.ai`
**Storage:** Decentralized blob storage (EVM + storage network)

Models are uploaded via the 0G SDK:
```typescript
import { ZgFile, Indexer } from '@0glabs/0g-ts-sdk';

const zgFile = await ZgFile.fromNodeFileBuffer(modelBuffer, 'model.json');
const [tree, err] = await zgFile.merkleTree();
const [tx, uploadErr] = await indexer.upload(zgFile, rpcUrl, signer);
// CID (merkle root) stored in model registry
```

Models are served via: `ZERO_G_GATEWAY_URL/{rootHash}`

### 6.4 Inference Serving

Real-time inference happens in Avatar AI service during active matches:

```
AI Warzone  ──POST /avatar/predict──▶  Avatar AI Service
{
  "agentId": "uuid",
  "gameState": {
    "position": { "x": 10, "y": 0, "z": 5 },
    "health": 85,
    "enemiesNearby": [...],
    "cooldowns": { "shoot": 0, "ability": 2.3 }
  }
}
◀── { "action": "SHOOT", "confidence": 0.87, "distribution": {...} }
```

Model is loaded from 0G Network on first inference call and cached in memory (LRU cache, max 50 models).

---

## 7. Blockchain & Smart Contracts

### 7.1 Network Configuration

| Parameter | Value |
|-----------|-------|
| Network | 0G Mainnet |
| Chain ID | 16600 |
| RPC URL | `https://evmrpc.0g.ai` |
| Explorer | `https://chainscan.0g.ai` |
| Currency | OG (native) |
| Hardhat target | `zerogMainnet` |

### 7.2 Smart Contracts

#### `AgentRegistry.sol`
Manages on-chain agent identities as non-transferable NFT-like records.

```solidity
function registerAgent(
    address owner,
    string calldata name,
    string calldata metadataURI
) external returns (uint256 agentId);

function updateStatus(uint256 agentId, AgentStatus status) external onlyOperator;
function getAgent(uint256 agentId) external view returns (AgentRecord memory);
function getAgentsByOwner(address owner) external view returns (uint256[] memory);
```

**Roles:** `DEFAULT_ADMIN_ROLE`, `OPERATOR_ROLE` (set to `OPERATOR_ADDRESS` from env)

#### `GameEconomy.sol`
Manages prize pools, entry fees, and reward distribution.

```solidity
function createPrizePool(bytes32 tournamentId, uint256 amount) external payable;
function depositEntryFee(bytes32 matchId) external payable;
function distributeReward(
    bytes32 matchId,
    address winner,
    address loser,
    uint256 winnerAmount,
    uint256 platformFee
) external onlySettler;
```

#### `Treasury.sol`
Collects platform fees; only `ADMIN_ROLE` can withdraw.

```solidity
function depositFee() external payable;
function withdraw(address to, uint256 amount) external onlyAdmin;
function getBalance() external view returns (uint256);
```

#### `Settlement.sol`
ECDSA-signed settlement for trustless prize distribution.

```solidity
function settleMatch(
    bytes32 matchId,
    address winner,
    uint256 winnerAmount,
    uint256 platformFee,
    bytes calldata signature
) external;

function settleTournament(
    bytes32 tournamentId,
    address[] calldata recipients,
    uint256[] calldata amounts,
    bytes calldata signature
) external;

function verifySettlement(bytes32 settlementId) external view returns (bool);
```

The `signature` is created off-chain by the Settlement Service using `SETTLER_PRIVATE_KEY`.

### 7.3 Deployment

```bash
cd contracts
cp .env.example .env
# Fill in DEPLOYER_PRIVATE_KEY, OPERATOR_ADDRESS, BLOCKCHAIN_RPC_URL
npx hardhat run scripts/deploy.ts --network zerogMainnet
```

After deployment, add the contract addresses to Render environment variables:
- `AGENT_REGISTRY_ADDRESS`
- `GAME_ECONOMY_ADDRESS`
- `TREASURY_ADDRESS`
- `SETTLEMENT_ADDRESS`

---

## 8. Database Schemas

### 8.1 PostgreSQL (Prisma — Shared Instance)

All PostgreSQL-backed services share one `kult_platform` database. Tables are namespaced by service prefix.

#### Agent Registry (`agent-registry-service/prisma/schema.prisma`)

```prisma
model Agent {
  id               String      @id @default(uuid())
  name             String
  description      String?
  ownerWallet      String
  hotWalletAddress String?
  currentModelId   String?
  elo              Int         @default(1000)
  status           AgentStatus @default(ACTIVE)
  onChainId        String?
  wins             Int         @default(0)
  losses           Int         @default(0)
  totalMatches     Int         @default(0)
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  @@map("agent_registry_agents")
}

enum AgentStatus {
  ACTIVE
  INACTIVE
  SUSPENDED
  COMPETING
}
```

#### Arena (`arena-service/prisma/schema.prisma`)

```prisma
model Match {
  id              String      @id @default(uuid())
  player1AgentId  String
  player2AgentId  String
  status          MatchStatus @default(PENDING)
  winnerId        String?
  warzoneMatchId  String?
  eloChange       Int?
  prizeAmount     String?
  startedAt       DateTime?
  completedAt     DateTime?
  createdAt       DateTime    @default(now())
  @@map("arena_matches")
}

model QueueEntry {
  agentId    String   @id
  elo        Int
  queuedAt   DateTime @default(now())
  attempts   Int      @default(0)
  @@map("arena_queue_entries")
}

enum MatchStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

#### Tournament (`tournament-service/prisma/schema.prisma`)

```prisma
model Tournament {
  id              String           @id @default(uuid())
  name            String
  description     String?
  prizePool       String           // decimal ETH string
  entryFee        String?
  maxParticipants Int
  startTime       DateTime
  status          TournamentStatus @default(REGISTRATION)
  participants    TournamentParticipant[]
  matches         TournamentMatch[]
  createdAt       DateTime         @default(now())
  @@map("tournament_tournaments")
}

model TournamentParticipant {
  id           String     @id @default(uuid())
  tournamentId String
  agentId      String
  seed         Int?
  placement    Int?
  wins         Int        @default(0)
  losses       Int        @default(0)
  eliminatedAt DateTime?
  @@map("tournament_participants")
}

model TournamentMatch {
  id           String     @id @default(uuid())
  tournamentId String
  round        Int
  matchIndex   Int
  player1Id    String?
  player2Id    String?
  winnerId     String?
  status       MatchStatus @default(PENDING)
  @@map("tournament_matches")
}

enum TournamentStatus {
  REGISTRATION
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

#### Ranking (`ranking-service/prisma/schema.prisma`)

```prisma
model EloRecord {
  id        String   @id @default(uuid())
  agentId   String
  matchId   String
  oldElo    Int
  newElo    Int
  change    Int
  createdAt DateTime @default(now())
  @@map("ranking_elo_records")
}
```

#### Wallet (`wallet-service/prisma/schema.prisma`)

```prisma
model AgentWallet {
  agentId          String   @id
  address          String   @unique
  encryptedPrivKey String   // AES-256-GCM encrypted
  iv               String   // base64 IV
  authTag          String   // base64 auth tag
  createdAt        DateTime @default(now())
  @@map("wallet_agent_wallets")
}

model WalletTransaction {
  id        String   @id @default(uuid())
  agentId   String
  txHash    String?
  type      String   // DEPOSIT | WITHDRAWAL | PRIZE | FEE
  amount    String   // decimal ETH string
  status    String
  createdAt DateTime @default(now())
  @@map("wallet_transactions")
}
```

#### AI Transactions (`ai-transaction-service/prisma/schema.prisma`)

```prisma
model AITransaction {
  id            String   @id @default(uuid())
  agentId       String
  requestedBy   String   // service name
  contractAddr  String
  methodName    String
  params        Json
  status        TxStatus @default(PENDING)
  txHash        String?
  failReason    String?
  attempts      Int      @default(0)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@map("ai_tx_transactions")
}

enum TxStatus {
  PENDING
  POLICY_FAILED
  SIGNED
  BROADCAST
  CONFIRMED
  FAILED
}
```

#### Settlement (`settlement-service/prisma/schema.prisma`)

```prisma
model Settlement {
  id            String           @id @default(uuid())
  type          SettlementType
  referenceId   String           // matchId or tournamentId
  winnerId      String
  amount        String
  platformFee   String
  status        SettlementStatus @default(PENDING)
  txHash        String?
  onChainHash   String?
  createdAt     DateTime         @default(now())
  @@map("settlement_settlements")
}

enum SettlementType { MATCH TOURNAMENT }
enum SettlementStatus { PENDING PROCESSING SETTLED FAILED }
```

### 8.2 MongoDB (Atlas — Telemetry Service)

**Database:** `kult_telemetry`
**Collection:** `telemetry_events`

```javascript
// Document structure
{
  _id: ObjectId,
  agentId: "uuid",
  matchId: "uuid",
  eventType: "SHOOT",
  position: { x: 10.5, y: 0, z: -3.2 },
  payload: { targetAgentId: "uuid", damage: 25, weapon: "PISTOL" },
  timestamp: ISODate("2025-01-01T12:00:00.000Z"),
  createdAt: ISODate("2025-01-01T12:00:00.050Z")
}

// Indexes
db.telemetry_events.createIndex({ matchId: 1, timestamp: 1 });
db.telemetry_events.createIndex({ agentId: 1, timestamp: -1 });
db.telemetry_events.createIndex({ timestamp: 1 }, { expireAfterSeconds: 7776000 }); // 90 day TTL
```

---

## 9. Queue Architecture (BullMQ)

All BullMQ queues use the shared Redis instance.

| Queue Name | Producer | Worker Service | Job Type | Interval |
|------------|----------|----------------|----------|----------|
| `matchmaking` | Arena Service (startup) | Arena Service | Repeatable | Every 5s |
| `training` | Arena Service (after match) | Avatar AI Service | Standard | As needed |
| `transaction` | Settlement/AI Tx Service | AI Transaction Service | Standard | As needed |

### Matchmaking Job (Arena Service)
```typescript
// Repeatable every 5000ms
const job = await matchmakingQueue.add(
  'scan-queue',
  {},
  { repeat: { every: 5000 }, jobId: 'matchmaking-scan' }
);

// Worker logic: scan Redis sorted set of queued agents by ELO
// Find pairs within ±(50 + 50 * Math.floor(waitMinutes / 0.5)) ELO range
```

### Training Job (Avatar AI Service)
```typescript
interface TrainingJobData {
  agentId: string;
  matchId: string;
  modelVersion: number;
}
// Worker: fetch telemetry → prepare dataset → train → upload to 0G → update model registry
```

### Transaction Job (AI Transaction Service)
```typescript
interface TransactionJobData {
  transactionId: string;
  agentId: string;
  contractAddr: string;
  encodedData: string;
}
// Worker: policy check → wallet sign → broadcast → confirm
```

---

## 10. WebSocket Channels

The Arena Service exposes WebSocket at port 3004 (proxied through Gateway at `/arena/ws`).

### Connection
```
wss://kult-gateway.onrender.com/arena/ws
Headers: { Authorization: "Bearer <jwt>" }
```

### Subscribe to Match Events
```json
// Client → Server
{ "type": "subscribe", "channel": "match:events", "matchId": "uuid" }

// Server → Client (event stream)
{ "type": "match:event", "matchId": "uuid", "event": { "agentId": "...", "type": "SHOOT", "position": {...}, "timestamp": "..." } }
{ "type": "match:completed", "matchId": "uuid", "winnerId": "uuid", "finalElos": { "agentId1": 1050, "agentId2": 950 } }
```

### Subscribe to Agent Status
```json
// Client → Server
{ "type": "subscribe", "channel": "agent:status", "agentId": "uuid" }

// Server → Client
{ "type": "agent:status", "agentId": "uuid", "status": "COMPETING", "currentMatch": "uuid" }
```

### Subscribe to ELO Updates
```json
// Client → Server
{ "type": "subscribe", "channel": "elo:leaderboard" }

// Server → Client (after each match)
{ "type": "elo:updated", "entries": [{ "agentId": "...", "elo": 1050, "rank": 1 }, ...] }
```

---

## 11. API Reference — All Endpoints

All API calls go through the Gateway at `https://kult-gateway.onrender.com`.

Authentication: Include `Authorization: Bearer <jwt>` header on all endpoints except `/auth/*`.

---

### 11.1 Authentication (via Gateway)

#### `POST /auth/nonce`
Request a sign challenge for wallet authentication.

**Request:**
```json
{ "walletAddress": "0xABC...123" }
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "nonce": "Sign this message to authenticate with KULT platform. Nonce: a1b2c3d4",
    "expiresAt": "2025-01-01T12:05:00.000Z"
  }
}
```

---

#### `POST /auth/wallet`
Authenticate using a signed wallet message. Returns JWT access + refresh tokens.

**Request:**
```json
{
  "walletAddress": "0xABC...123",
  "signature": "0xsignature...",
  "nonce": "Sign this message to authenticate with KULT platform. Nonce: a1b2c3d4"
}
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiJ9...",
    "expiresIn": 86400,
    "walletAddress": "0xABC...123"
  }
}
```

---

#### `POST /auth/refresh`
Get a new access token using a refresh token.

**Request:**
```json
{ "refreshToken": "eyJhbGciOiJIUzI1NiJ9..." }
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
    "expiresIn": 86400
  }
}
```

---

#### `GET /auth/me`
Returns the authenticated user's wallet address and linked agents.

**Headers:** `Authorization: Bearer <token>`
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "walletAddress": "0xABC...123",
    "agents": ["uuid1", "uuid2"]
  }
}
```

---

### 11.2 Agents

#### `POST /agents`
Register a new AI agent. Creates DB record + calls `AgentRegistry.sol`.

**Headers:** `Authorization: Bearer <token>`
**Request:**
```json
{
  "name": "Alpha Bot",
  "description": "My first AI agent",
  "ownerWallet": "0xABC...123"
}
```
**Response `201`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Alpha Bot",
    "ownerWallet": "0xABC...123",
    "elo": 1000,
    "status": "ACTIVE",
    "wins": 0,
    "losses": 0,
    "totalMatches": 0,
    "onChainId": "42",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

---

#### `GET /agents/leaderboard`
Top agents by ELO.

**Query params:** `limit` (1–100, default 20), `offset` (default 0)
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "entries": [
      { "rank": 1, "agentId": "uuid", "name": "Alpha Bot", "elo": 1450, "wins": 32, "losses": 5 }
    ],
    "total": 1
  }
}
```

---

#### `GET /agents/:agentId`
Get full agent details by UUID.

**Response `200`:**
```json
{
  "success": true,
  "data": { "id": "uuid", "name": "...", "elo": 1200, "status": "ACTIVE", "currentModelId": "uuid", ... }
}
```
**Response `404`:** Agent not found.

---

#### `GET /agents/owner/:wallet`
Get all agents owned by a wallet address.

**Response `200`:**
```json
{ "success": true, "data": [ { "id": "uuid", "name": "...", "elo": 1000 } ] }
```

---

#### `PATCH /agents/:agentId/status`
Update agent status (owner or admin only).

**Request:**
```json
{ "status": "INACTIVE" }
```
**Valid statuses:** `ACTIVE`, `INACTIVE`, `SUSPENDED`
**Response `200`:** Updated agent object.

---

#### `PATCH /agents/:agentId/model`
Update the agent's active AI model.

**Request:**
```json
{ "modelId": "uuid" }
```
**Response `200`:** Updated agent object with new `currentModelId`.

---

#### `PATCH /agents/:agentId/elo` *(Internal)*
Update agent ELO. Called by Ranking Service. Requires `x-internal-secret` header.

**Request:**
```json
{ "elo": 1150 }
```
**Response `200`:** Updated agent object.

---

#### `PATCH /agents/:agentId/hot-wallet`
Associate a hot wallet address with an agent.

**Request:**
```json
{ "hotWalletAddress": "0xDEF...456" }
```
**Response `200`:** Updated agent object.

---

#### `DELETE /agents/:agentId`
Soft-delete / deactivate an agent. Sets status to `INACTIVE`.

**Response `200`:**
```json
{ "success": true, "message": "Agent deactivated" }
```

---

### 11.3 Models

#### `POST /models`
Register a new model version.

**Request:**
```json
{
  "agentId": "uuid",
  "version": "1.0.0",
  "storageCid": "0xmerkleroot...",
  "architecture": "dense-256x3",
  "trainingMatchIds": ["uuid1", "uuid2"],
  "accuracy": 0.847,
  "metadata": {}
}
```
**Response `201`:** Model record with `downloadUrl`.

---

#### `GET /models/agent/:agentId`
Get all model versions for an agent.

**Response `200`:** Array of model records, sorted by `createdAt` descending.

---

#### `GET /models/:modelId`
Get a specific model version.

**Response `200`:** Model record with `downloadUrl` pointing to 0G gateway.

---

#### `PATCH /models/:modelId/activate`
Set this model version as the active one for its agent.

**Response `200`:** Updated model record.

---

### 11.4 Avatar AI

#### `POST /avatar/behavior`
Submit match telemetry to train a new behavioral model. Queues a training job.

**Request:**
```json
{
  "agentId": "uuid",
  "matchId": "uuid",
  "forceRetrain": false
}
```
**Response `202`:**
```json
{
  "success": true,
  "data": { "jobId": "training:uuid:1704067200000", "status": "QUEUED" }
}
```

---

#### `POST /avatar/train`
Start an explicit training run (admin/advanced use).

**Request:**
```json
{
  "agentId": "uuid",
  "matchIds": ["uuid1", "uuid2", "uuid3"],
  "epochs": 50,
  "learningRate": 0.001
}
```
**Response `202`:**
```json
{
  "success": true,
  "data": { "jobId": "training:uuid:...", "status": "QUEUED", "estimatedMinutes": 3 }
}
```

---

#### `GET /avatar/model/:agentId`
Get the current model info for an agent.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "modelId": "uuid",
    "version": "1.2.0",
    "storageCid": "0xmerkle...",
    "downloadUrl": "https://0g-gateway.example.com/0xmerkle.../model.json",
    "accuracy": 0.891,
    "trainingMatchCount": 45
  }
}
```

---

#### `POST /avatar/predict`
Real-time action inference from a game state vector. Called by AI Warzone.

**Request:**
```json
{
  "agentId": "uuid",
  "gameState": {
    "position": { "x": 10.5, "y": 0, "z": -3.2 },
    "health": 75,
    "shield": 0,
    "ammo": 12,
    "enemiesNearby": [
      { "agentId": "uuid2", "distance": 15.3, "health": 100, "angle": 45 }
    ],
    "cooldowns": { "shoot": 0, "ability": 2.3, "reload": 0 },
    "lastAction": "MOVE",
    "roundTime": 12.5
  }
}
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "action": "SHOOT",
    "confidence": 0.87,
    "distribution": {
      "MOVE": 0.05, "SHOOT": 0.87, "ABILITY": 0.04, "RELOAD": 0.02, "PICKUP": 0.02
    },
    "latencyMs": 3
  }
}
```

---

#### `GET /avatar/training/:jobId/status`
Check the status of a training job.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "jobId": "training:uuid:...",
    "status": "TRAINING",
    "progress": 0.65,
    "currentEpoch": 32,
    "totalEpochs": 50,
    "startedAt": "2025-01-01T12:00:00.000Z",
    "estimatedCompletionAt": "2025-01-01T12:03:30.000Z"
  }
}
```
**Statuses:** `QUEUED`, `FETCHING_DATA`, `TRAINING`, `UPLOADING`, `COMPLETED`, `FAILED`

---

### 11.5 Arena / Matches

#### `POST /arena/queue`
Add an agent to the matchmaking queue.

**Request:**
```json
{ "agentId": "uuid" }
```
**Response `201`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "elo": 1200,
    "queuedAt": "2025-01-01T12:00:00.000Z",
    "estimatedWaitSeconds": 15
  }
}
```
**Response `409`:** Agent already in queue or in active match.

---

#### `DELETE /arena/queue/:agentId`
Remove an agent from the matchmaking queue.

**Response `200`:**
```json
{ "success": true, "message": "Removed from queue" }
```
**Response `404`:** Agent not in queue.

---

#### `GET /arena/queue/:agentId/status`
Check an agent's queue position and wait time.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "inQueue": true,
    "queuedAt": "2025-01-01T12:00:00.000Z",
    "waitSeconds": 12,
    "eloRange": { "min": 1100, "max": 1300 },
    "potentialMatches": 3
  }
}
```

---

#### `GET /arena/matches/active`
List all currently active (in-progress) matches.

**Response `200`:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "player1AgentId": "uuid",
      "player2AgentId": "uuid",
      "status": "IN_PROGRESS",
      "startedAt": "2025-01-01T12:00:00.000Z",
      "warzoneMatchId": "wz-12345"
    }
  ]
}
```

---

#### `GET /arena/matches/:matchId`
Get full match details.

**Response `200`:** Full match object including players, status, winner, ELO change.
**Response `404`:** Match not found.

---

#### `GET /arena/matches/agent/:agentId`
Get match history for an agent.

**Query params:** `status` (optional: `PENDING | IN_PROGRESS | COMPLETED | CANCELLED`), `page`, `limit`
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "matches": [...],
    "total": 47,
    "page": 1,
    "limit": 20
  }
}
```

---

#### `POST /arena/matches/:matchId/result`
Report the result of a match. Called by AI Warzone callback.

**Request:**
```json
{
  "winnerId": "uuid",
  "loserId": "uuid",
  "finalStats": {
    "player1": { "kills": 3, "deaths": 1 },
    "player2": { "kills": 1, "deaths": 3 }
  }
}
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "matchId": "uuid",
    "winnerId": "uuid",
    "eloChange": 24,
    "settlementId": "uuid"
  }
}
```

---

#### `POST /arena/matches/:matchId/cancel`
Cancel a pending or in-progress match.

**Request:**
```json
{ "reason": "Warzone timeout" }
```
**Response `200`:** Cancelled match object.

---

### 11.6 Ranking

#### `POST /ranking/update` *(Internal)*
Update ELO ratings after a match. Called by Arena Service. Requires `x-internal-secret` header.

**Request:**
```json
{
  "matchId": "uuid",
  "winnerId": "uuid",
  "loserId": "uuid",
  "winnerElo": 1200,
  "loserElo": 1150
}
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "winner": { "agentId": "uuid", "oldElo": 1200, "newElo": 1224, "change": 24 },
    "loser": { "agentId": "uuid", "oldElo": 1150, "newElo": 1126, "change": -24 }
  }
}
```

---

#### `GET /ranking/leaderboard`
Global ELO leaderboard. Cached in Redis for 60s.

**Query params:** `limit` (1–500, default 100), `offset` (default 0)
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "entries": [
      { "rank": 1, "agentId": "uuid", "name": "Alpha Bot", "elo": 1450, "wins": 32, "losses": 5, "totalMatches": 37 }
    ],
    "limit": 100,
    "offset": 0,
    "count": 1
  }
}
```

---

#### `GET /ranking/agent/:agentId`
Get rank info and stats for a specific agent.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "name": "Alpha Bot",
    "elo": 1200,
    "rank": 15,
    "percentile": 87.5,
    "wins": 24,
    "losses": 8,
    "totalMatches": 32,
    "winRate": 0.75
  }
}
```

---

#### `GET /ranking/agent/:agentId/history`
Paginated ELO change history for an agent.

**Query params:** `page` (default 1), `limit` (1–100, default 20)
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "history": [
      { "matchId": "uuid", "oldElo": 1176, "newElo": 1200, "change": 24, "createdAt": "2025-01-01T..." }
    ],
    "total": 32,
    "page": 1,
    "limit": 20
  }
}
```

---

### 11.7 Tournaments

#### `POST /tournaments` *(Admin)*
Create a new tournament. Requires `x-admin-key` header.

**Request:**
```json
{
  "name": "KULT Grand Prix #1",
  "description": "First official 8-agent tournament",
  "prizePool": "0.5",
  "entryFee": "0.01",
  "maxParticipants": 8,
  "startTime": "2025-02-01T20:00:00.000Z"
}
```
**Validation:**
- `prizePool`, `entryFee`: decimal ETH string (e.g., `"0.5"`)
- `maxParticipants`: power of 2 (2, 4, 8, 16, 32, 64...)
- `startTime`: ISO 8601 datetime

**Response `201`:** Full tournament object.

---

#### `GET /tournaments`
List tournaments with optional status filter and pagination.

**Query params:** `status` (`REGISTRATION | IN_PROGRESS | COMPLETED | CANCELLED`), `page`, `limit`
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "tournaments": [
      { "id": "uuid", "name": "KULT Grand Prix #1", "status": "REGISTRATION", "participants": 3, "maxParticipants": 8, "prizePool": "0.5", "startTime": "..." }
    ],
    "total": 12,
    "page": 1,
    "limit": 20
  }
}
```

---

#### `GET /tournaments/:tournamentId`
Get full tournament details including all participants.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "KULT Grand Prix #1",
    "status": "REGISTRATION",
    "prizePool": "0.5",
    "entryFee": "0.01",
    "maxParticipants": 8,
    "participants": [
      { "agentId": "uuid", "name": "Alpha Bot", "elo": 1200, "seed": null }
    ],
    "startTime": "2025-02-01T20:00:00.000Z"
  }
}
```
**Response `404`:** Tournament not found.

---

#### `POST /tournaments/:tournamentId/join`
Register an AI agent for a tournament.

**Request:**
```json
{ "agentId": "uuid" }
```
**Response `201`:**
```json
{
  "success": true,
  "data": {
    "tournamentId": "uuid",
    "agentId": "uuid",
    "joinedAt": "2025-01-01T12:00:00.000Z"
  }
}
```
**Response `404`:** Tournament or agent not found.
**Response `409`:** Already registered / tournament full / registration closed.

---

#### `POST /tournaments/:tournamentId/start` *(Admin)*
Start a tournament and generate brackets. Requires `x-admin-key` header.

**Validation:** At least 2 participants required.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "tournamentId": "uuid",
    "status": "IN_PROGRESS",
    "bracket": [
      {
        "round": 1,
        "matches": [
          { "matchId": "uuid", "player1": { "agentId": "uuid", "seed": 1, "elo": 1450 }, "player2": { "agentId": "uuid", "seed": 8, "elo": 950 } }
        ]
      }
    ]
  }
}
```

---

#### `GET /tournaments/:tournamentId/bracket`
Returns the current bracket state.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "tournamentId": "uuid",
    "currentRound": 1,
    "rounds": [
      {
        "round": 1,
        "matches": [
          { "matchId": "uuid", "player1Id": "uuid", "player2Id": "uuid", "winnerId": null, "status": "IN_PROGRESS" }
        ]
      }
    ]
  }
}
```

---

#### `POST /tournaments/:tournamentId/match-result`
Report a match result and advance the bracket.

**Request:**
```json
{ "matchId": "uuid", "winnerId": "uuid" }
```
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "matchId": "uuid",
    "winnerId": "uuid",
    "nextRound": {
      "round": 2,
      "newMatch": { "matchId": "uuid", "player1Id": "uuid", "player2Id": null }
    },
    "tournamentStatus": "IN_PROGRESS"
  }
}
```
**Response `409`:** Match already has a winner / match not in progress.

---

#### `GET /tournaments/:tournamentId/leaderboard`
Current standings for a tournament.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "tournamentId": "uuid",
    "standings": [
      { "rank": 1, "agentId": "uuid", "name": "Alpha Bot", "wins": 2, "losses": 0, "status": "ACTIVE" },
      { "rank": 2, "agentId": "uuid", "name": "Beta Bot", "wins": 2, "losses": 0, "status": "ACTIVE" }
    ]
  }
}
```

---

### 11.8 Telemetry

#### `POST /telemetry/events`
Batch insert telemetry events (up to 100 per request). Called by AI Warzone during matches.

**Request:**
```json
{
  "events": [
    {
      "agentId": "uuid",
      "matchId": "uuid",
      "eventType": "SHOOT",
      "position": { "x": 10.5, "y": 0, "z": -3.2 },
      "payload": { "targetAgentId": "uuid", "damage": 25, "weapon": "PISTOL" },
      "timestamp": "2025-01-01T12:00:01.234Z"
    }
  ]
}
```
**Event types:** `MOVE`, `SHOOT`, `DEATH`, `KILL`, `PICKUP`, `ABILITY`, `ROUND_START`, `ROUND_END`, `MATCH_END`

**Response `201`** (all succeeded):
```json
{ "success": true, "data": { "inserted": 5, "failed": 0 } }
```
**Response `207`** (partial failure):
```json
{ "success": false, "data": { "inserted": 4, "failed": 1, "errors": [...] } }
```

---

#### `GET /telemetry/match/:matchId`
All events for a match in chronological order.

**Query params:** `page` (default 1), `limit` (1–1000, default 200)
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "matchId": "uuid",
    "events": [...],
    "total": 1543,
    "page": 1,
    "limit": 200
  }
}
```

---

#### `GET /telemetry/agent/:agentId/stats`
Aggregated gameplay statistics for an agent across all matches.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "totalMatches": 32,
    "totalKills": 87,
    "totalDeaths": 45,
    "kdRatio": 1.93,
    "accuracy": 0.342,
    "avgSurvivalTime": 42.5,
    "avgPosition": { "x": 2.1, "y": 0, "z": -1.4 },
    "favoriteAction": "SHOOT",
    "actionDistribution": { "MOVE": 0.41, "SHOOT": 0.38, "ABILITY": 0.12, "PICKUP": 0.09 }
  }
}
```

---

#### `GET /telemetry/agent/:agentId/replay/:matchId`
Full match replay data for a specific agent in a specific match.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "matchId": "uuid",
    "eventCount": 312,
    "duration": 48.3,
    "events": [
      { "eventType": "ROUND_START", "timestamp": "...", "payload": { "round": 1 } },
      { "eventType": "MOVE", "position": { "x": 0, "y": 0, "z": 0 }, "timestamp": "..." }
    ]
  }
}
```
**Response `404`:** No replay data found.

---

### 11.9 Wallet

#### `POST /wallet/generate`
Generate and store a new hot wallet for an agent.

**Request:**
```json
{ "agentId": "uuid" }
```
**Response `201`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "address": "0xNEW...WALLET",
    "createdAt": "2025-01-01T12:00:00.000Z"
  }
}
```
> ⚠️ Private key is never returned. It is AES-256-GCM encrypted in the database.

---

#### `GET /wallet/:agentId`
Get wallet address for an agent.

**Response `200`:**
```json
{
  "success": true,
  "data": { "agentId": "uuid", "address": "0xWALLET...", "createdAt": "..." }
}
```

---

#### `GET /wallet/:agentId/balance`
Get on-chain balance of an agent's wallet (live RPC call to 0G Mainnet).

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "address": "0xWALLET...",
    "balanceWei": "1250000000000000000",
    "balanceEth": "1.25"
  }
}
```

---

#### `GET /wallet/:agentId/transactions`
Transaction history for an agent's wallet.

**Query params:** `page`, `limit`
**Response `200`:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      { "id": "uuid", "type": "PRIZE", "amount": "0.1", "txHash": "0x...", "status": "CONFIRMED", "createdAt": "..." }
    ],
    "total": 15
  }
}
```

---

#### `POST /wallet/:agentId/deposit`
Record an expected deposit (used for entry fee accounting).

**Request:**
```json
{ "amount": "0.01", "txHash": "0x..." }
```
**Response `201`:** Transaction record.

---

#### `POST /wallet/sign` *(Internal)*
Sign a transaction with the agent's private key. Requires `x-internal-secret` header. Called only by AI Transaction Service.

**Request:**
```json
{
  "agentId": "uuid",
  "to": "0xCONTRACT...",
  "data": "0xencoded...",
  "value": "0",
  "gasLimit": "100000"
}
```
**Response `200`:**
```json
{
  "success": true,
  "data": { "signedTx": "0xf86c...", "txHash": "0x..." }
}
```

---

### 11.10 AI Transactions

#### `POST /transactions/request`
Submit a transaction request for policy review and execution.

**Request:**
```json
{
  "agentId": "uuid",
  "contractAddr": "0xSETTLEMENT...",
  "methodName": "settleMatch",
  "params": { "matchId": "0xhex...", "amount": "100000000000000000" },
  "requestedBy": "settlement-service"
}
```
**Response `202`:**
```json
{
  "success": true,
  "data": {
    "transactionId": "uuid",
    "status": "PENDING",
    "queuePosition": 2
  }
}
```
**Response `403`:** Policy check failed (limit exceeded, contract not whitelisted, agent suspended).

---

#### `GET /transactions/:txId`
Get transaction status and details.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "agentId": "uuid",
    "status": "CONFIRMED",
    "txHash": "0x...",
    "contractAddr": "0x...",
    "methodName": "settleMatch",
    "attempts": 1,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

#### `GET /transactions/agent/:agentId`
All transactions for an agent.

**Query params:** `page`, `limit`, `status`
**Response `200`:** Paginated transaction list.

---

#### `GET /transactions/agent/:agentId/spending`
Daily and total spending summary for an agent.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "agentId": "uuid",
    "todaySpentEth": "0.05",
    "totalSpentEth": "1.23",
    "dailyLimitEth": "0.1",
    "remainingTodayEth": "0.05",
    "txCountToday": 3
  }
}
```

---

#### `POST /transactions/:txId/retry` *(Admin)*
Retry a failed transaction. Requires `x-admin-key` header.

**Response `200`:**
```json
{ "success": true, "data": { "transactionId": "uuid", "status": "PENDING", "newAttempt": 2 } }
```

---

### 11.11 Settlement

#### `POST /settlement/match`
Initiate settlement for a completed match.

**Request:**
```json
{
  "matchId": "uuid",
  "winnerId": "uuid",
  "loserId": "uuid",
  "prizeAmount": "0.1",
  "platformFeePercent": 5
}
```
**Response `202`:**
```json
{
  "success": true,
  "data": {
    "settlementId": "uuid",
    "status": "PENDING",
    "winnerAmount": "0.095",
    "platformFee": "0.005"
  }
}
```

---

#### `POST /settlement/tournament`
Initiate settlement for a completed tournament.

**Request:**
```json
{
  "tournamentId": "uuid",
  "placements": [
    { "agentId": "uuid", "place": 1, "amount": "0.35" },
    { "agentId": "uuid", "place": 2, "amount": "0.15" }
  ],
  "platformFee": "0.05"
}
```
**Response `202`:**
```json
{
  "success": true,
  "data": { "settlementId": "uuid", "status": "PENDING", "totalAmount": "0.5" }
}
```

---

#### `GET /settlement/:settlementId`
Get settlement status and on-chain details.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "MATCH",
    "status": "SETTLED",
    "txHash": "0x...",
    "onChainHash": "0x...",
    "amount": "0.095",
    "platformFee": "0.005",
    "settledAt": "2025-01-01T12:05:00.000Z"
  }
}
```

---

#### `POST /settlement/verify/:settlementId`
Re-verify an on-chain settlement hash.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "settlementId": "uuid",
    "verified": true,
    "onChainHash": "0x...",
    "blockNumber": 1234567
  }
}
```

---

## 12. Deployment Blueprint

### 12.1 Render Services & URLs

All services deployed via `render.yaml` Blueprint. After first deploy, your service URLs are:

| Service | Render Name | URL |
|---------|-------------|-----|
| Gateway | `kult-gateway` | `https://kult-gateway.onrender.com` |
| Agent Registry | `kult-agent-registry` | `https://kult-agent-registry.onrender.com` |
| Model Registry | `kult-model-registry` | `https://kult-model-registry.onrender.com` |
| Avatar AI | `kult-avatar-ai` | `https://kult-avatar-ai.onrender.com` |
| Arena | `kult-arena` | `https://kult-arena.onrender.com` |
| Ranking | `kult-ranking` | `https://kult-ranking.onrender.com` |
| Tournament | `kult-tournament` | `https://kult-tournament.onrender.com` |
| Telemetry | `kult-telemetry` | `https://kult-telemetry.onrender.com` |
| Wallet | `kult-wallet` | `https://kult-wallet.onrender.com` |
| AI Transaction | `kult-ai-transaction` | `https://kult-ai-transaction.onrender.com` |
| Settlement | `kult-settlement` | `https://kult-settlement.onrender.com` |
| PostgreSQL | `kult-postgres` | Internal (via `fromDatabase:`) |
| Redis | `kult-redis` | Internal (via `fromService:`) |

**Primary client endpoint:** `https://kult-gateway.onrender.com`

### 12.2 Environment Variables Reference

#### Auto-generated by Render
| Variable | Generated By | Description |
|----------|-------------|-------------|
| `JWT_SECRET` | `generateValue: true` | 64-char random secret for JWT signing |
| `INTERNAL_API_SECRET` | `generateValue: true` | Secret for internal service-to-service calls |
| `WALLET_ENCRYPTION_KEY` | `generateValue: true` | 32-byte key for AES-256-GCM wallet encryption |
| `DATABASE_URL` | `fromDatabase:` | PostgreSQL connection string |
| `REDIS_URL` | `fromService:` | Redis connection string |

#### Must Be Set Manually in Render Dashboard (`sync: false`)
| Variable | Service(s) | Example Value |
|----------|-----------|---------------|
| `MONGODB_URI` | telemetry-service | `mongodb+srv://kult_platform:PASSWORD@cluster0.alv060t.mongodb.net/kult_telemetry` |
| `ADMIN_API_KEY` | gateway, tournament, ai-transaction | Any strong random string |
| `SETTLER_PRIVATE_KEY` | settlement-service | `0x309b...` (deployer private key) |
| `AGENT_REGISTRY_ADDRESS` | agent-registry, settlement | Contract address from deploy |
| `GAME_ECONOMY_ADDRESS` | settlement, wallet | Contract address from deploy |
| `TREASURY_ADDRESS` | settlement | Contract address from deploy |
| `SETTLEMENT_ADDRESS` | settlement | Contract address from deploy |

#### Set in `kult-blockchain` envVarGroup
| Variable | Value |
|----------|-------|
| `BLOCKCHAIN_RPC_URL` | `https://evmrpc.0g.ai` |
| `CHAIN_ID` | `16600` |
| `ZERO_G_STORAGE_URL` | `https://rpc.0g.ai` (storage RPC) |
| `ZERO_G_GATEWAY_URL` | `https://gateway.0g.ai` (download gateway) |

#### Set in `kult-shared-auth` envVarGroup
| Variable | Value |
|----------|-------|
| `JWT_SECRET` | Auto-generated |
| `INTERNAL_API_SECRET` | Auto-generated |

#### Service-Specific Variables
| Variable | Service | Description |
|----------|---------|-------------|
| `AI_WARZONE_SERVICE_URL` | arena-service | `https://ai-warzone.onrender.com` |
| `PORT` | all services | Set to service's port (3000–3010) |
| `LOG_LEVEL` | all services | `info` (prod) / `debug` (dev) |
| `MAX_TX_AMOUNT_ETH` | ai-transaction | Max single TX in ETH (e.g., `1.0`) |

### 12.3 Post-Deploy Wiring Checklist

After Blueprint deploys successfully:

**1. Database Migrations**
Each Prisma-enabled service runs `prisma migrate deploy` in its CMD. Verify in Render logs:
```
gateway-service       → no migration (no Prisma)
agent-registry        → ✅ Applied X migrations
arena-service         → ✅ Applied X migrations
ranking-service       → ✅ Applied X migrations
tournament-service    → ✅ Applied X migrations
wallet-service        → ✅ Applied X migrations
ai-transaction        → ✅ Applied X migrations
settlement-service    → ✅ Applied X migrations
```

**2. Set Secret Variables**
In Render Dashboard → Environment → Set these for each service:
```
[ ] MONGODB_URI          → telemetry-service
[ ] ADMIN_API_KEY        → gateway, tournament-service, ai-transaction-service
[ ] SETTLER_PRIVATE_KEY  → settlement-service
[ ] WALLET_ENCRYPTION_KEY → wallet-service (if not auto-generated)
```

**3. Deploy Smart Contracts**
```bash
cd contracts
npx hardhat run scripts/deploy.ts --network zerogMainnet
# Copy output addresses:
# AgentRegistry deployed to: 0x...
# GameEconomy deployed to: 0x...
# Treasury deployed to: 0x...
# Settlement deployed to: 0x...
```

**4. Set Contract Addresses in Render**
```
AGENT_REGISTRY_ADDRESS → agent-registry-service, settlement-service
GAME_ECONOMY_ADDRESS   → settlement-service, wallet-service
TREASURY_ADDRESS       → settlement-service
SETTLEMENT_ADDRESS     → settlement-service
```

**5. Whitelist AI Warzone Callback IPs** (if AI Warzone has a fixed IP)
In Render → Gateway service → firewall: allow AI Warzone's egress IPs.

**6. Health Check Verification**
```bash
curl https://kult-gateway.onrender.com/health
# Expected: { "status": "ok", "service": "gateway", "version": "1.0.0" }
```

**7. Seed Initial Data (Optional)**
```bash
cd contracts
npx hardhat run scripts/seed.ts --network zerogMainnet
```

**8. Test Auth Flow**
```bash
# 1. Get nonce
curl -X POST https://kult-gateway.onrender.com/auth/nonce \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "0xYOUR_WALLET"}'

# 2. Sign the nonce with your wallet (ethers.js)
# ethers.wallet.signMessage(nonce)

# 3. Authenticate
curl -X POST https://kult-gateway.onrender.com/auth/wallet \
  -H "Content-Type: application/json" \
  -d '{"walletAddress": "0x...", "signature": "0x...", "nonce": "..."}'
```

---

## 13. Local Development

### Prerequisites
- Node.js 20+
- Docker Desktop
- (Optional) `psql` CLI or TablePlus for database inspection

### Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd kult-platform
npm install

# 2. Copy env template
cp .env.example .env
# Edit .env — set MONGODB_URI, BLOCKCHAIN_RPC_URL, etc.

# 3. Start infrastructure (Postgres + Redis)
docker compose up postgres redis -d

# 4. Run all migrations
npx prisma migrate dev --schema services/agent-registry-service/prisma/schema.prisma
npx prisma migrate dev --schema services/arena-service/prisma/schema.prisma
npx prisma migrate dev --schema services/ranking-service/prisma/schema.prisma
npx prisma migrate dev --schema services/tournament-service/prisma/schema.prisma
npx prisma migrate dev --schema services/wallet-service/prisma/schema.prisma
npx prisma migrate dev --schema services/ai-transaction-service/prisma/schema.prisma
npx prisma migrate dev --schema services/settlement-service/prisma/schema.prisma

# 5. Build shared module
npm run build -w @kult/shared

# 6. Start all services (separate terminals or use concurrently)
npm run dev -w @kult/gateway-service      # :3000
npm run dev -w @kult/agent-registry-service # :3001
npm run dev -w @kult/model-registry-service # :3002
npm run dev -w @kult/avatar-ai-service    # :3003
npm run dev -w @kult/arena-service        # :3004
npm run dev -w @kult/ranking-service      # :3005
npm run dev -w @kult/tournament-service   # :3006
npm run dev -w @kult/telemetry-service    # :3007
npm run dev -w @kult/wallet-service       # :3008
npm run dev -w @kult/ai-transaction-service # :3009
npm run dev -w @kult/settlement-service   # :3010
```

### Using Docker Compose (Full Stack)

```bash
# Build and run everything
docker compose up --build

# Just a specific service
docker compose up gateway-service agent-registry-service postgres redis

# View logs
docker compose logs -f arena-service

# Rebuild a specific service after code changes
docker compose up --build arena-service
```

### Monorepo Scripts

```bash
# Build all
npm run build --workspaces

# Build shared only
npm run build -w @kult/shared

# Type-check all services
npm run typecheck --workspaces

# Run tests (if configured)
npm test --workspaces
```

---

## 14. Smart Contract Deployment

### Setup

```bash
cd contracts
npm install                    # Installs Hardhat + OpenZeppelin + ethers
cp .env.example .env
```

Edit `contracts/.env`:
```env
DEPLOYER_PRIVATE_KEY=0x309b5ca4e4a8894cc034a21900eaf3ff86ad89200c1317d32d22ce4ce6d91508
OPERATOR_ADDRESS=0x63F63DC442299cCFe470657a769fdC6591d65eCa
BLOCKCHAIN_RPC_URL=https://evmrpc.0g.ai
CHAIN_ID=16600
```

> ⚠️ `contracts/.env` is in `.gitignore`. Never commit private keys.

### Compile

```bash
npx hardhat compile
# Outputs to contracts/artifacts/
# Type bindings to contracts/typechain-types/
```

### Deploy to 0G Mainnet

```bash
npx hardhat run scripts/deploy.ts --network zerogMainnet
```

Expected output:
```
Deploying with account: 0x63F63DC442299cCFe470657a769fdC6591d65eCa
AgentRegistry deployed to: 0x...
GameEconomy deployed to: 0x...
Treasury deployed to: 0x...
Settlement deployed to: 0x...
Deployment complete. Copy these addresses to Render environment variables.
```

### Deploy to Local Hardhat Network (Testing)

```bash
npx hardhat node            # Starts local EVM
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/seed.ts --network localhost
```

### Verify Contracts (0G Explorer)

```bash
npx hardhat verify --network zerogMainnet 0xAGENT_REGISTRY_ADDRESS
npx hardhat verify --network zerogMainnet 0xGAME_ECONOMY_ADDRESS
npx hardhat verify --network zerogMainnet 0xTREASURY_ADDRESS
npx hardhat verify --network zerogMainnet 0xSETTLEMENT_ADDRESS
```

---

## 15. Security Model

### Authentication Flow
```
Client               Gateway              Chain
  |                     |                   |
  |-- POST /auth/nonce →|                   |
  |← {nonce} ──────────|                   |
  |                     |                   |
  | [Client signs nonce with wallet]        |
  |                     |                   |
  |-- POST /auth/wallet →|                  |
  |   {address,sig,nonce}|                  |
  |                     |-- verifyMessage ──|
  |                     |← signer === addr  |
  |← {accessToken,      |                  |
  |    refreshToken} ───|                   |
```

### Internal Service Security
- All internal endpoints require `x-internal-secret` header (auto-generated by Render, shared via `kult-shared-auth` envVarGroup).
- Admin endpoints require `x-admin-key` header (set manually in dashboard, never auto-generated).
- Services never call each other over the public internet — they use Render's private network (internal hostnames).

### Wallet Security
1. Agent hot wallets generated with `ethers.Wallet.createRandom()`.
2. Private key encrypted with AES-256-GCM before storage.
3. `WALLET_ENCRYPTION_KEY` stored only in Render dashboard, never in code.
4. Private keys are decrypted in-memory only inside Wallet Service's `/wallet/sign` endpoint.
5. The signed transaction (not the key) is returned to AI Transaction Service.
6. Keys are never logged, never included in API responses.

### Transaction Policy Engine (AI Transaction Service)
Prevents runaway AI spending:
- ✅ Contract must be in whitelist (`GAME_ECONOMY_ADDRESS`, `SETTLEMENT_ADDRESS`)
- ✅ Amount must be ≤ `MAX_TX_AMOUNT_ETH` per transaction
- ✅ Agent's daily total must be ≤ daily limit (tracked in Redis)
- ✅ Agent status must be `ACTIVE` (not `SUSPENDED`)
- ✅ Method name must be in allowed methods list

### Rate Limiting
- Global: 100 req/min per IP (Gateway)
- Auth endpoints: 10 req/min per IP
- Telemetry batch: 100 events per request (service-level validation)
- Leaderboard: Redis cache (60s TTL reduces DB hammering)

### Secret Rotation
To rotate `JWT_SECRET`:
1. Update in Render Dashboard.
2. Trigger redeploy of gateway-service.
3. All existing JWTs immediately invalidated — users must re-authenticate.

To rotate `WALLET_ENCRYPTION_KEY`:
1. **DO NOT** simply change the key — all existing encrypted keys become unreadable.
2. Run a migration script that: decrypts all keys with old key → re-encrypts with new key → stores new ciphertext.
3. Only then update the env var and redeploy wallet-service.

---

*Documentation generated for KULT Platform v1.0.0 — 0G Mainnet · March 2026*
