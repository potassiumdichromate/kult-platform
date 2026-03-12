// =============================================================================
// KULT Platform — ethers.js Blockchain Client
//
// Provides:
//   - A singleton JsonRpcProvider for read-only calls
//   - Typed contract factory methods for all 4 platform contracts
//   - Gas estimation helpers
//   - Transaction confirmation waiter
// =============================================================================

import {
  ethers,
  JsonRpcProvider,
  Contract,
  ContractRunner,
  TransactionReceipt,
} from 'ethers';
import { config } from '../config/index.js';
import { BlockchainError } from '../utils/errors.js';

// ABI imports
import AgentRegistryABI from './abis/AgentRegistry.abi.json' assert { type: 'json' };
import GameEconomyABI from './abis/GameEconomy.abi.json' assert { type: 'json' };
import TreasuryABI from './abis/Treasury.abi.json' assert { type: 'json' };
import SettlementABI from './abis/Settlement.abi.json' assert { type: 'json' };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContractName =
  | 'agentRegistry'
  | 'gameEconomy'
  | 'treasury'
  | 'settlement';

interface ContractConfig {
  address: string;
  abi: ethers.InterfaceAbi;
}

// ---------------------------------------------------------------------------
// ABI registry
// ---------------------------------------------------------------------------

const CONTRACT_CONFIGS: Record<ContractName, ContractConfig> = {
  agentRegistry: {
    address: config.AGENT_REGISTRY_CONTRACT,
    abi: AgentRegistryABI as ethers.InterfaceAbi,
  },
  gameEconomy: {
    address: config.GAME_ECONOMY_CONTRACT,
    abi: GameEconomyABI as ethers.InterfaceAbi,
  },
  treasury: {
    address: config.TREASURY_CONTRACT,
    abi: TreasuryABI as ethers.InterfaceAbi,
  },
  settlement: {
    address: config.SETTLEMENT_CONTRACT,
    abi: SettlementABI as ethers.InterfaceAbi,
  },
};

// ---------------------------------------------------------------------------
// Provider singleton
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __kultProvider: JsonRpcProvider | undefined;
}

function createProvider(): JsonRpcProvider {
  const provider = new JsonRpcProvider(config.BLOCKCHAIN_RPC_URL, {
    chainId: config.CHAIN_ID,
    name: 'kult-chain',
  });

  // Eagerly probe connectivity in dev so startup failures surface immediately
  if (config.NODE_ENV !== 'production') {
    void provider.getNetwork().catch((err: unknown) => {
      console.error('[blockchain] Failed to connect to RPC:', err);
    });
  }

  return provider;
}

/**
 * Read-only JsonRpcProvider singleton.
 * Use this for view/pure contract calls.
 */
export const provider: JsonRpcProvider =
  config.NODE_ENV === 'production'
    ? createProvider()
    : (globalThis.__kultProvider ??
       (globalThis.__kultProvider = createProvider()));

// ---------------------------------------------------------------------------
// Contract factory
// ---------------------------------------------------------------------------

/**
 * Returns a typed ethers Contract instance.
 *
 * Pass `signerOrProvider` to override; defaults to the read-only provider.
 *
 * ```ts
 * // Read-only
 * const registry = getContract('agentRegistry');
 * const agentData = await registry.getAgent(agentIdBytes32);
 *
 * // Write (requires signer)
 * const signer = new ethers.Wallet(privateKey, provider);
 * const registry = getContract('agentRegistry', signer);
 * await registry.registerAgent(agentId, hotWallet, modelHash);
 * ```
 */
export function getContract(
  name: ContractName,
  signerOrProvider?: ContractRunner
): Contract {
  const cfg = CONTRACT_CONFIGS[name];
  return new Contract(cfg.address, cfg.abi, signerOrProvider ?? provider);
}

// ---------------------------------------------------------------------------
// Signer factory
// ---------------------------------------------------------------------------

/**
 * Creates a Wallet (signer) from a raw private key, connected to the
 * platform provider.
 *
 * IMPORTANT: the private key should be decrypted from encrypted storage
 * immediately before use and never held in memory longer than necessary.
 */
export function createSigner(privateKey: string): ethers.Wallet {
  return new ethers.Wallet(privateKey, provider);
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Waits for `confirmations` blocks after a transaction is mined.
 * Throws `BlockchainError` if the transaction reverted.
 *
 * @param txHash        - Transaction hash (0x...)
 * @param confirmations - Number of confirmations to wait for (default: 1)
 * @param timeoutMs     - Max time to wait in ms (default: 120 s)
 */
export async function waitForTransaction(
  txHash: string,
  confirmations = 1,
  timeoutMs = 120_000
): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 3_000;

  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash);

    if (receipt !== null) {
      if (receipt.confirmations() !== undefined) {
        const confs = await receipt.confirmations();
        if (confs >= confirmations) {
          if (receipt.status === 0) {
            throw new BlockchainError(
              `Transaction ${txHash} reverted`,
              txHash
            );
          }
          return receipt;
        }
      }
    }

    await sleep(pollInterval);
  }

  throw new BlockchainError(
    `Transaction ${txHash} not confirmed within ${timeoutMs} ms`,
    txHash
  );
}

// ---------------------------------------------------------------------------
// Gas estimation
// ---------------------------------------------------------------------------

/**
 * Estimates gas for a contract call and adds a 20% buffer.
 *
 * ```ts
 * const gasLimit = await estimateGas('agentRegistry', 'registerAgent', [
 *   agentIdBytes32, hotWallet, modelHash
 * ]);
 * ```
 */
export async function estimateGas(
  contractName: ContractName,
  method: string,
  args: unknown[],
  overrides: ethers.Overrides = {}
): Promise<bigint> {
  const contract = getContract(contractName);

  const fn = contract[method];
  if (typeof fn !== 'function') {
    throw new BlockchainError(
      `Method "${method}" not found on contract "${contractName}"`
    );
  }

  try {
    const estimate: bigint = await contract[method].estimateGas(
      ...args,
      overrides
    );
    // Add 20% buffer
    return (estimate * 120n) / 100n;
  } catch (err) {
    throw new BlockchainError(
      `Gas estimation failed for ${contractName}.${method}: ${String(err)}`
    );
  }
}

/**
 * Fetches current gas price and computes a fast-lane (110%) override.
 */
export async function getGasPrice(): Promise<{
  gasPrice: bigint;
  maxFeePerGas: bigint;
}> {
  const feeData = await provider.getFeeData();
  const base = feeData.gasPrice ?? ethers.parseUnits('30', 'gwei');
  return {
    gasPrice: base,
    maxFeePerGas: (base * 110n) / 100n,
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Converts an agent UUID string to bytes32 suitable for on-chain calls.
 * The UUID is hashed with keccak256 to produce a deterministic bytes32.
 */
export function agentIdToBytes32(agentId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

/**
 * Converts a match UUID to bytes32.
 */
export function matchIdToBytes32(matchId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(matchId));
}

/**
 * Returns the current block number.
 */
export async function getBlockNumber(): Promise<number> {
  return provider.getBlockNumber();
}

/**
 * Returns the native balance of an address in wei as a string.
 */
export async function getNativeBalance(address: string): Promise<string> {
  const balance = await provider.getBalance(address);
  return balance.toString();
}

/**
 * Returns `true` if the provider is connected and the chain ID matches config.
 */
export async function isProviderHealthy(): Promise<boolean> {
  try {
    const network = await provider.getNetwork();
    return Number(network.chainId) === config.CHAIN_ID;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
