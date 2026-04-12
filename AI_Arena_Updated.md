
# AI Arena — Architecture & System Flow Documentation

## Overview

AI Arena is a decentralized AI-driven PvP gaming protocol where autonomous agents, trained from player gameplay data, compete in deterministic matches with tokenized stakes.

The system integrates:

* Deterministic game simulation (Unity)
* AI training pipeline (0G infrastructure)
* Match validation (backend authority)
* On-chain escrow settlement (Solana)

This document defines the complete architecture, data flow, and system interactions.

---

# 1. System Architecture

## 1.1 High-Level Components

```
Client (Unity)
    ↓
Match Authority (Node.js)
    ↓
Storage Layer (MongoDB + Redis)
    ↓
0G Infrastructure
    ├── 0G DA (Data Availability)
    ├── 0G Storage
    └── 0G Compute
    ↓
Solana Blockchain (Escrow Contract)
```

---

## 1.2 Component Responsibilities

### Client (Unity)

* Executes deterministic gameplay simulation
* Loads AI personality parameters
* Emits gameplay events
* Submits match results to backend

### Match Authority (Node.js)

* Handles matchmaking
* Generates signed match payloads
* Validates match results
* Prevents cheating
* Triggers escrow settlement

### MongoDB

* Stores player personality profiles
* Stores match metadata
* Caches processed AI outputs

### Redis

* Matchmaking queue
* Active session tracking

### 0G Infrastructure

#### 0G DA (Data Availability)

* Stores match logs (immutable)
* Stores state hashes
* Enables verifiability

#### 0G Storage

* Stores structured training datasets

#### 0G Compute

* Runs AI training jobs
* Outputs personality vectors

---

## Blockchain (Solana)

* Handles token escrow
* Releases funds based on validated results

---

# 2. Identity Model

Each player is uniquely identified by:

```
walletAddress (Solana)
```

This wallet address is used as:

* Player identity
* AI agent identity
* Personality lookup key
* Match participant reference

---

# 3. Match Lifecycle

## 3.1 Matchmaking Request

### Request

```
POST /matchmaking/join
```

**Body:**

```json
{
  "walletAddress": "F3k...9Xa"
}
```

---

## 3.2 Match Creation (Server-Side)

The Match Authority:

* Finds opponent OR assigns dummy
* Generates match payload
* Creates escrow session

### Payload Structure

```json
{
  "arenaId": "arena_872364",
  "p1": "wallet_A",
  "p2": "wallet_B",
  "timestamp": 1712929200
}
```

### Signature

```
signature = HMAC_SHA256(payload, server_secret)
```

---

## 3.3 Secure Game Launch

Unity loads with:

```
https://build.warzonewarriors.xyz/?arenaId=...&p1=...&p2=...&ts=...&sig=...
```

### Validation (Client-Side)

* Recompute signature
* Reject if invalid

---

## 3.4 Escrow Initialization (On-Chain)

Both players deposit:

```
1 $ARENA token
```

Escrow stores:

* arenaId
* player addresses
* locked funds

---

# 4. Gameplay Execution

## 4.1 Personality Loading

Unity fetches:

```
GET /personality/:wallet
```

### Example Response

```json
{
  "wallet": "wallet_A",
  "aggression": 0.82,
  "reactionTime": 110,
  "aimBias": 0.67,
  "strategy": "rusher"
}
```

---

## 4.2 Deterministic AI

AI behavior is derived from:

* Personality parameters
* Game state
* Predefined AI scripts

No runtime LLM inference is used during matches.

---

## 4.3 Event-Based Logging

Instead of frame logs, only events are recorded.

### Example

```json
[
  { "t": 0.5, "type": "move", "direction": "left" },
  { "t": 1.2, "type": "shoot", "hit": true },
  { "t": 1.3, "type": "damage", "value": 25 }
]
```

---

## 4.4 State Hashing

Each event updates a rolling hash:

```
stateHash = SHA256(previousHash + event)
```

### Example

```
H0 = "init"
H1 = hash(H0 + event1)
H2 = hash(H1 + event2)
...
Hn = finalStateHash
```

---

# 5. Match Submission

## Endpoint

```
POST /match/submit
```

### Payload

```json
{
  "arenaId": "arena_872364",
  "p1": "wallet_A",
  "p2": "wallet_B",
  "events": [...],
  "finalStateHash": "0xabc123..."
}
```

---

# 6. Match Validation (Critical Layer)

## 6.1 Deterministic Replay

Server:

* Replays events
* Recomputes state
* Verifies hash consistency

---

## 6.2 Anti-Cheat Checks

Examples:

* Impossible reaction time
* Invalid movement sequences
* Unrealistic hit accuracy

---

## 6.3 Winner Determination

```json
{
  "winner": "wallet_A",
  "score": {
    "p1": 100,
    "p2": 80
  }
}
```

---

## 6.4 Result Signing

```json
{
  "arenaId": "arena_872364",
  "winner": "wallet_A"
}
```

Signature:

```
sign(result, server_private_key)
```

---

# 7. Escrow Settlement

Smart contract accepts only:

* Valid arenaId
* Backend signature

### Flow

```
Backend → Contract
        → verify signature
        → release funds
        → deduct commission
```

---

# 8. Data Availability Layer (0G DA)

## Stored Data

* Match event logs
* State hashes
* Match metadata references

### Example Entry

```json
{
  "arenaId": "arena_872364",
  "eventsCID": "bafy...",
  "finalHash": "0xabc123..."
}
```

---

## Purpose

* Public verifiability
* Tamper resistance
* Dispute resolution

---

# 9. AI Training Pipeline

## 9.1 Data Filtering

Only validated matches are used.

### Criteria

```
match.validated == true
confidenceScore > threshold
no anomaly detected
```

---

## 9.2 Dataset Structure (0G Storage)

```json
{
  "wallet": "wallet_A",
  "matchId": "arena_872364",
  "actions": [...],
  "outcome": "win",
  "confidenceScore": 0.91
}
```

---

## 9.3 Training Jobs (0G Compute)

Executed periodically.

### Input:

* Batch of player datasets

### Output:

```json
{
  "wallet": "wallet_A",
  "aggression": 0.78,
  "reactionTime": 105,
  "aimBias": 0.64,
  "strategy": "aggressive"
}
```

---

## 9.4 Personality Update Flow

```
0G Compute → Personality Service → MongoDB → Unity
```

---

# 10. Dummy Player Logic

## Option A (Recommended)

* Platform-funded wallet
* Treated as real match

## Option B

* No escrow interaction
* Practice-only mode

---

# 11. Security Model

## 11.1 Trust Boundaries

| Component       | Trust Level |
| --------------- | ----------- |
| Unity Client    | Untrusted   |
| Match Authority | Trusted     |
| Blockchain      | Trustless   |
| 0G DA           | Verifiable  |

---

## 11.2 Key Protections

* Signed match payloads
* Server-side winner validation
* Deterministic replay
* State hashing
* Escrow signature verification

---

# 12. Data Models

## Match Session

```json
{
  "arenaId": "arena_872364",
  "p1": "wallet_A",
  "p2": "wallet_B",
  "events": [...],
  "stateHash": "0xabc123",
  "winner": "wallet_A",
  "verified": true,
  "createdAt": "timestamp"
}
```

---

## Personality

```json
{
  "wallet": "wallet_A",
  "aggression": 0.82,
  "reactionTime": 110,
  "aimBias": 0.67,
  "strategy": "rusher"
}
```

---

# 13. Scaling Considerations

## Recommended Additions

### Redis

* Match queues
* Active sessions

### Worker Queue (BullMQ)

* Match validation jobs
* Training pipeline jobs

### CDN

* Unity build delivery using cloudfare

---

# 14. Non-Negotiable Constraints

* Client must never determine winner
* Client must never interact with escrow directly
* All match payloads must be signed
* All payouts must be server-authorized or proof-verified

---

# 15. Future Enhancements

* Zero-knowledge proof-based match validation
* Fully on-chain verification of results
* Agent NFT standardization
* Tournament brackets with verifiable outcomes

---

# Conclusion

AI Arena combines deterministic simulation, decentralized AI training, and blockchain settlement into a unified competitive system. The architecture ensures:

* Fairness through deterministic validation
* Security through server authority and cryptographic signatures
* Transparency via data availability layers
* Scalability through decentralized compute infrastructure

---
