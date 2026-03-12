/**
 * seed-database.ts
 *
 * Seeds the KULT platform PostgreSQL database via Prisma with:
 *   - 10 sample AI agents (varied ELO ratings)
 *   - 1 sample model per agent
 *   - 1 sample tournament
 *
 * Usage (from kult-platform root):
 *   npx ts-node scripts/seed-database.ts
 *
 * Requires:
 *   - DATABASE_URL set in environment (or .env)
 *   - Prisma schema migrated (prisma migrate deploy)
 */

import { PrismaClient } from "@prisma/client";
import * as crypto from "crypto";

const prisma = new PrismaClient({
  log: ["query", "info", "warn", "error"],
});

// ─────────────────────────────────────────────────────────────────────────────
//  Data definitions
// ─────────────────────────────────────────────────────────────────────────────

interface AgentSeed {
  name: string;
  elo: number;
  walletAddress: string;
  hotWalletAddress: string | null;
  strategy: string;
}

const AGENT_SEEDS: AgentSeed[] = [
  {
    name: "NeuralReaper-X",
    elo: 2847,
    walletAddress: "0x1111111111111111111111111111111111111111",
    hotWalletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    strategy: "aggressive",
  },
  {
    name: "QuantumViper",
    elo: 2651,
    walletAddress: "0x2222222222222222222222222222222222222222",
    hotWalletAddress: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    strategy: "balanced",
  },
  {
    name: "ShadowProtocol",
    elo: 2512,
    walletAddress: "0x3333333333333333333333333333333333333333",
    hotWalletAddress: null,
    strategy: "stealth",
  },
  {
    name: "IronHarbinger",
    elo: 2389,
    walletAddress: "0x4444444444444444444444444444444444444444",
    hotWalletAddress: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    strategy: "defensive",
  },
  {
    name: "NanoSpecter",
    elo: 2244,
    walletAddress: "0x5555555555555555555555555555555555555555",
    hotWalletAddress: null,
    strategy: "guerrilla",
  },
  {
    name: "VectorStrike",
    elo: 2105,
    walletAddress: "0x6666666666666666666666666666666666666666",
    hotWalletAddress: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    strategy: "aggressive",
  },
  {
    name: "BytePredator",
    elo: 1980,
    walletAddress: "0x7777777777777777777777777777777777777777",
    hotWalletAddress: null,
    strategy: "adaptive",
  },
  {
    name: "OmegaWarden",
    elo: 1823,
    walletAddress: "0x8888888888888888888888888888888888888888",
    hotWalletAddress: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    strategy: "balanced",
  },
  {
    name: "PrismCipher",
    elo: 1677,
    walletAddress: "0x9999999999999999999999999999999999999999",
    hotWalletAddress: null,
    strategy: "sniper",
  },
  {
    name: "ZeroPoint",
    elo: 1500,
    walletAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    hotWalletAddress: "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    strategy: "balanced",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateAgentId(): string {
  return crypto.randomBytes(32).toString("hex");
}

function generateModelChecksum(): string {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("Starting database seed...");
  log("─".repeat(60));

  // ── Clear existing seed data (idempotent) ─────────────────────
  log("Clearing existing seed data...");
  await prisma.$transaction([
    prisma.tournamentParticipant.deleteMany({}),
    prisma.tournament.deleteMany({}),
    prisma.model.deleteMany({}),
    prisma.agent.deleteMany({}),
  ]);
  log("Existing data cleared.");

  // ── Create agents ─────────────────────────────────────────────
  log("Creating 10 sample agents...");
  const createdAgents = [];

  for (const seed of AGENT_SEEDS) {
    const agent = await prisma.agent.create({
      data: {
        id: generateAgentId(),
        name: seed.name,
        elo: seed.elo,
        walletAddress: seed.walletAddress,
        hotWalletAddress: seed.hotWalletAddress,
        strategy: seed.strategy,
        isActive: true,
        wins: Math.floor(seed.elo / 50),
        losses: Math.floor((3000 - seed.elo) / 80),
        kills: Math.floor(seed.elo * 1.2),
        deaths: Math.floor((3000 - seed.elo) * 0.4),
      },
    });
    createdAgents.push(agent);
    log(`  Created agent: ${agent.name} (ELO: ${agent.elo}, id: ${agent.id})`);
  }

  // ── Create models (one per agent) ────────────────────────────
  log("\nCreating sample models for each agent...");
  const createdModels = [];

  for (const agent of createdAgents) {
    const model = await prisma.model.create({
      data: {
        agentId: agent.id,
        version: "1.0.0",
        checksum: generateModelChecksum(),
        architecture: "transformer",
        parameters: {
          layers: 12,
          hiddenDim: 768,
          heads: 12,
          contextLength: 2048,
          trainedEpochs: Math.floor(Math.random() * 50) + 10,
          learningRate: 0.0001,
        },
        isProduction: true,
        uploadedAt: new Date(),
      },
    });
    createdModels.push(model);
    log(`  Created model v${model.version} for agent ${agent.name}`);
  }

  // ── Create sample tournament ──────────────────────────────────
  log("\nCreating sample tournament...");

  // Pick the top 8 agents by ELO for the tournament
  const tournamentAgents = [...createdAgents]
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 8);

  const tournament = await prisma.tournament.create({
    data: {
      name: "KULT Genesis Cup #1",
      description: "Inaugural KULT AI gaming tournament — top 8 agents compete.",
      status: "SCHEDULED",
      maxParticipants: 8,
      entryFeeWei: "10000000000000000", // 0.01 ETH
      prizePoolWei: "80000000000000000", // 0.08 ETH
      startTime: new Date(Date.now() + 24 * 60 * 60 * 1000), // starts in 24h
      endTime: new Date(Date.now() + 48 * 60 * 60 * 1000),   // ends in 48h
      resultHash: null,
      onChainId: null,
      participants: {
        create: tournamentAgents.map((agent, index) => ({
          agentId: agent.id,
          seed: index + 1,
          status: "REGISTERED",
        })),
      },
    },
    include: {
      participants: true,
    },
  });

  log(`  Created tournament: "${tournament.name}" (id: ${tournament.id})`);
  log(`  Participants: ${tournament.participants.length}`);
  for (const p of tournament.participants) {
    const agent = createdAgents.find((a) => a.id === p.agentId)!;
    log(`    Seed ${p.seed}: ${agent.name} (ELO: ${agent.elo})`);
  }

  // ── Summary ───────────────────────────────────────────────────
  log("\n" + "─".repeat(60));
  log("Seed complete. Summary:");
  log(`  Agents created     : ${createdAgents.length}`);
  log(`  Models created     : ${createdModels.length}`);
  log(`  Tournaments created: 1`);
  log(`  Tournament participants: ${tournament.participants.length}`);
  log("─".repeat(60));
}

main()
  .catch((error) => {
    console.error("[seed] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
