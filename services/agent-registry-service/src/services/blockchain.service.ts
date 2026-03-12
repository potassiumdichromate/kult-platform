import { ethers } from 'ethers';
import { winstonLogger } from '../logger';

// Minimal ABI for AgentRegistry on-chain contract
const AGENT_REGISTRY_ABI = [
  'function registerAgent(string calldata agentId, address ownerWallet) external returns (bool)',
  'function updateHotWallet(string calldata agentId, address hotWalletAddress) external returns (bool)',
  'function getAgent(string calldata agentId) external view returns (address owner, address hotWallet, bool exists)',
  'function verifyOwnership(string calldata agentId, address wallet) external view returns (bool)',
  'event AgentRegistered(string indexed agentId, address indexed ownerWallet)',
  'event HotWalletUpdated(string indexed agentId, address indexed hotWallet)',
];

interface AgentOnChain {
  owner: string;
  hotWallet: string;
  exists: boolean;
}

class BlockchainService {
  private provider: ethers.JsonRpcProvider | null = null;
  private signer: ethers.Wallet | null = null;
  private contract: ethers.Contract | null = null;
  private contractReadOnly: ethers.Contract | null = null;
  private initialized = false;

  private init(): void {
    if (this.initialized) return;

    const rpcUrl = process.env.RPC_URL;
    const contractAddress = process.env.AGENT_REGISTRY_CONTRACT_ADDRESS;
    const privateKey = process.env.REGISTRY_OPERATOR_PRIVATE_KEY;

    if (!rpcUrl || !contractAddress || !privateKey) {
      winstonLogger.warn(
        'Blockchain service not fully configured. Running in simulation mode.',
        {
          hasRpcUrl: !!rpcUrl,
          hasContractAddress: !!contractAddress,
          hasPrivateKey: !!privateKey,
        }
      );
      this.initialized = true;
      return;
    }

    try {
      this.provider = new ethers.JsonRpcProvider(rpcUrl);
      this.signer = new ethers.Wallet(privateKey, this.provider);
      this.contract = new ethers.Contract(
        contractAddress,
        AGENT_REGISTRY_ABI,
        this.signer
      );
      this.contractReadOnly = new ethers.Contract(
        contractAddress,
        AGENT_REGISTRY_ABI,
        this.provider
      );
      this.initialized = true;
      winstonLogger.info('Blockchain service initialized', { contractAddress });
    } catch (err) {
      winstonLogger.error('Failed to initialize blockchain service', {
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      this.initialized = true; // Mark as initialized so we don't retry endlessly
    }
  }

  private isConfigured(): boolean {
    this.init();
    return this.contract !== null && this.signer !== null;
  }

  /**
   * Registers an agent on-chain by calling the AgentRegistry contract.
   * Returns the transaction hash on success.
   */
  async registerAgentOnChain(
    agentId: string,
    ownerWallet: string
  ): Promise<{ txHash: string; simulated: boolean }> {
    if (!this.isConfigured()) {
      winstonLogger.warn('Blockchain not configured: simulating registerAgentOnChain', {
        agentId,
        ownerWallet,
      });
      return {
        txHash: `sim_${Date.now()}_${agentId.slice(0, 8)}`,
        simulated: true,
      };
    }

    try {
      const tx = await (this.contract as ethers.Contract).registerAgent(
        agentId,
        ownerWallet
      );
      const receipt = await tx.wait();

      winstonLogger.info('Agent registered on-chain', {
        agentId,
        ownerWallet,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
      });

      return { txHash: receipt.hash, simulated: false };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Blockchain call failed';
      winstonLogger.error('registerAgentOnChain failed', {
        agentId,
        ownerWallet,
        error: message,
      });
      throw new Error(`Blockchain registration failed: ${message}`);
    }
  }

  /**
   * Updates the hot wallet address for an agent on-chain.
   */
  async updateHotWallet(
    agentId: string,
    hotWalletAddress: string
  ): Promise<{ txHash: string; simulated: boolean }> {
    if (!this.isConfigured()) {
      winstonLogger.warn('Blockchain not configured: simulating updateHotWallet', {
        agentId,
        hotWalletAddress,
      });
      return {
        txHash: `sim_${Date.now()}_${agentId.slice(0, 8)}`,
        simulated: true,
      };
    }

    try {
      const tx = await (this.contract as ethers.Contract).updateHotWallet(
        agentId,
        hotWalletAddress
      );
      const receipt = await tx.wait();

      winstonLogger.info('Hot wallet updated on-chain', {
        agentId,
        hotWalletAddress,
        txHash: receipt.hash,
      });

      return { txHash: receipt.hash, simulated: false };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Blockchain call failed';
      winstonLogger.error('updateHotWallet failed', {
        agentId,
        hotWalletAddress,
        error: message,
      });
      throw new Error(`Blockchain hot-wallet update failed: ${message}`);
    }
  }

  /**
   * Reads the on-chain agent record and verifies wallet ownership.
   */
  async verifyAgentOwnership(
    agentId: string,
    wallet: string
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      winstonLogger.warn(
        'Blockchain not configured: simulating verifyAgentOwnership as true',
        { agentId, wallet }
      );
      return true;
    }

    try {
      const result: boolean = await (
        this.contractReadOnly as ethers.Contract
      ).verifyOwnership(agentId, wallet);
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Blockchain read failed';
      winstonLogger.error('verifyAgentOwnership failed', {
        agentId,
        wallet,
        error: message,
      });
      throw new Error(`Ownership verification failed: ${message}`);
    }
  }

  /**
   * Reads the full on-chain agent record.
   */
  async getOnChainAgent(agentId: string): Promise<AgentOnChain | null> {
    if (!this.isConfigured()) {
      winstonLogger.warn('Blockchain not configured: returning null for getOnChainAgent', {
        agentId,
      });
      return null;
    }

    try {
      const result = await (
        this.contractReadOnly as ethers.Contract
      ).getAgent(agentId);
      return {
        owner: result.owner,
        hotWallet: result.hotWallet,
        exists: result.exists,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Blockchain read failed';
      winstonLogger.error('getOnChainAgent failed', {
        agentId,
        error: message,
      });
      return null;
    }
  }
}

export const blockchainService = new BlockchainService();
