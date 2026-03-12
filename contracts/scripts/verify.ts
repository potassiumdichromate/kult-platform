/**
 * verify.ts
 *
 * Verifies all KULT platform contracts on the configured block explorer
 * (Etherscan-compatible) using the Hardhat verify plugin.
 *
 * Reads deployment addresses from ../deployments/{networkName}.json
 * which is written by deploy.ts.
 *
 * Usage:
 *   npx hardhat run scripts/verify.ts --network zerog
 */

import { run, network, ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[verify] ${msg}`);
}

interface DeploymentData {
  deployer: string;
  operator: string;
  contracts: {
    AgentRegistry: string;
    Treasury: string;
    GameEconomy: string;
    Settlement: string;
  };
}

async function verifyContract(
  name: string,
  address: string,
  constructorArgs: unknown[]
): Promise<void> {
  log(`Verifying ${name} at ${address}...`);
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    log(`  ${name}: OK`);
  } catch (err: unknown) {
    // Hardhat verify throws if already verified — treat as success
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("already verified")) {
      log(`  ${name}: Already verified`);
    } else {
      log(`  ${name}: FAILED — ${msg}`);
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const networkName = network.name;
  log(`Network: ${networkName}`);

  // ── Load deployment data ──────────────────────────────────────
  const deploymentsDir = path.resolve(__dirname, "../../deployments");
  const dataFile = path.join(deploymentsDir, `${networkName}.json`);

  if (!fs.existsSync(dataFile)) {
    throw new Error(
      `No deployment file found at ${dataFile}. Run deploy.ts first.`
    );
  }

  const data: DeploymentData = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const { deployer, operator, contracts } = data;

  log(`Deployer : ${deployer}`);
  log(`Operator : ${operator}`);
  log(`Contracts:`);
  log(`  AgentRegistry : ${contracts.AgentRegistry}`);
  log(`  Treasury      : ${contracts.Treasury}`);
  log(`  GameEconomy   : ${contracts.GameEconomy}`);
  log(`  Settlement    : ${contracts.Settlement}`);
  log("─".repeat(60));

  // ── Verify each contract ──────────────────────────────────────
  // Constructor arguments must match those used in deploy.ts exactly.

  await verifyContract("AgentRegistry", contracts.AgentRegistry, [
    deployer,   // initialOwner
    operator,   // initialOperator
  ]);

  await verifyContract("Treasury", contracts.Treasury, [
    deployer,               // initialOwner
    contracts.AgentRegistry, // agentRegistry
    operator,               // initialOperator
  ]);

  await verifyContract("GameEconomy", contracts.GameEconomy, [
    deployer,               // initialOwner
    contracts.AgentRegistry, // agentRegistry
  ]);

  await verifyContract("Settlement", contracts.Settlement, [
    deployer,  // initialOwner
    operator,  // initialOperator
  ]);

  log("─".repeat(60));
  log("All contracts verified successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
