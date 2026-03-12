/**
 * deploy.ts
 *
 * Production deployment script for the KULT AI gaming platform contracts.
 *
 * Deployment order:
 *   1. AgentRegistry
 *   2. Treasury        (needs AgentRegistry address)
 *   3. GameEconomy     (needs AgentRegistry address)
 *   4. Settlement
 *
 * Post-deployment:
 *   - Sets backend operator on every contract
 *   - Seeds GameEconomy with 5 initial weapons
 *   - Writes addresses to ../deployments/{networkName}.json
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network localhost
 *   npx hardhat run scripts/deploy.ts --network zerog
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return v;
}

function log(msg: string) {
  console.log(`[deploy] ${msg}`);
}

async function waitBlocks(n: number) {
  // On local networks this is instant; on live networks it waits for n confirmations.
  if (network.name === "localhost" || network.name === "hardhat") return;
  const provider = ethers.provider;
  const current = await provider.getBlockNumber();
  log(`Waiting for ${n} confirmations (current block: ${current})...`);
  // poll
  await new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      const latest = await provider.getBlockNumber();
      if (latest >= current + n) {
        clearInterval(interval);
        resolve();
      }
    }, 4000);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Initial weapon catalogue
// ─────────────────────────────────────────────────────────────────────────────

interface WeaponDef {
  id: bigint;
  name: string;
  costEth: string; // human-readable ETH string
}

const INITIAL_WEAPONS: WeaponDef[] = [
  { id: 1n, name: "Plasma Rifle",    costEth: "0.01"  },
  { id: 2n, name: "Laser Sword",     costEth: "0.005" },
  { id: 3n, name: "Rocket Launcher", costEth: "0.025" },
  { id: 4n, name: "Sniper Drone",    costEth: "0.015" },
  { id: 5n, name: "EMP Grenade",     costEth: "0.003" },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const operatorAddress = env("OPERATOR_ADDRESS", deployer.address);

  log(`Network      : ${network.name} (chainId ${(await ethers.provider.getNetwork()).chainId})`);
  log(`Deployer     : ${deployer.address}`);
  log(`Operator     : ${operatorAddress}`);
  log(`Balance      : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  log("─".repeat(60));

  // ── 1. AgentRegistry ─────────────────────────────────────────
  log("Deploying AgentRegistry...");
  const AgentRegistryFactory = await ethers.getContractFactory("AgentRegistry");
  const agentRegistry = await AgentRegistryFactory.deploy(deployer.address, operatorAddress);
  await agentRegistry.waitForDeployment();
  const agentRegistryAddress = await agentRegistry.getAddress();
  log(`AgentRegistry deployed at: ${agentRegistryAddress}`);
  await waitBlocks(2);

  // ── 2. Treasury ───────────────────────────────────────────────
  log("Deploying Treasury...");
  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  const treasury = await TreasuryFactory.deploy(
    deployer.address,
    agentRegistryAddress,
    operatorAddress
  );
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  log(`Treasury deployed at: ${treasuryAddress}`);
  await waitBlocks(2);

  // ── 3. GameEconomy ────────────────────────────────────────────
  log("Deploying GameEconomy...");
  const GameEconomyFactory = await ethers.getContractFactory("GameEconomy");
  const gameEconomy = await GameEconomyFactory.deploy(deployer.address, agentRegistryAddress);
  await gameEconomy.waitForDeployment();
  const gameEconomyAddress = await gameEconomy.getAddress();
  log(`GameEconomy deployed at: ${gameEconomyAddress}`);
  await waitBlocks(2);

  // ── 4. Settlement ─────────────────────────────────────────────
  log("Deploying Settlement...");
  const SettlementFactory = await ethers.getContractFactory("Settlement");
  const settlementContract = await SettlementFactory.deploy(deployer.address, operatorAddress);
  await settlementContract.waitForDeployment();
  const settlementAddress = await settlementContract.getAddress();
  log(`Settlement deployed at: ${settlementAddress}`);
  await waitBlocks(2);

  // ── 5. Seed GameEconomy with initial weapons ──────────────────
  log("Adding initial weapons to GameEconomy...");
  for (const weapon of INITIAL_WEAPONS) {
    const cost = ethers.parseEther(weapon.costEth);
    const tx = await gameEconomy.addWeapon(weapon.id, weapon.name, cost);
    await tx.wait();
    log(`  [+] Weapon ${weapon.id}: "${weapon.name}" @ ${weapon.costEth} ETH`);
  }

  // ── 6. Verify deployments ─────────────────────────────────────
  log("Verifying deployment state...");

  const regOperator = await agentRegistry.operator();
  const regOwner = await agentRegistry.owner();
  log(`  AgentRegistry.owner    = ${regOwner} ${regOwner === deployer.address ? "OK" : "MISMATCH"}`);
  log(`  AgentRegistry.operator = ${regOperator} ${regOperator === operatorAddress ? "OK" : "MISMATCH"}`);

  const trsOperator = await treasury.operator();
  const trsRegistry = await treasury.registry();
  log(`  Treasury.operator = ${trsOperator} ${trsOperator === operatorAddress ? "OK" : "MISMATCH"}`);
  log(`  Treasury.registry = ${trsRegistry} ${trsRegistry === agentRegistryAddress ? "OK" : "MISMATCH"}`);

  const ecoRegistry = await gameEconomy.registry();
  const weaponIds = await gameEconomy.getAllWeaponIds();
  log(`  GameEconomy.registry = ${ecoRegistry} ${ecoRegistry === agentRegistryAddress ? "OK" : "MISMATCH"}`);
  log(`  GameEconomy.weapons  = [${weaponIds.join(", ")}]`);

  const sttlOperator = await settlementContract.operator();
  log(`  Settlement.operator = ${sttlOperator} ${sttlOperator === operatorAddress ? "OK" : "MISMATCH"}`);

  // ── 7. Write deployment addresses ────────────────────────────
  const deploymentData = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    operator: operatorAddress,
    contracts: {
      AgentRegistry: agentRegistryAddress,
      Treasury: treasuryAddress,
      GameEconomy: gameEconomyAddress,
      Settlement: settlementAddress,
    },
    weapons: INITIAL_WEAPONS.map((w) => ({
      id: Number(w.id),
      name: w.name,
      costEth: w.costEth,
    })),
  };

  const deploymentsDir = path.resolve(__dirname, "../../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const outFile = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deploymentData, null, 2), "utf8");
  log(`Deployment addresses written to ${outFile}`);

  log("─".repeat(60));
  log("Deployment complete.");
  log(`  AgentRegistry : ${agentRegistryAddress}`);
  log(`  Treasury      : ${treasuryAddress}`);
  log(`  GameEconomy   : ${gameEconomyAddress}`);
  log(`  Settlement    : ${settlementAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
