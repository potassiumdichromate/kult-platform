import { PrismaClient, Wallet, WalletTransaction } from '@prisma/client';
import { ethers } from 'ethers';
import Redis from 'ioredis';
import { logger } from '../middleware/logger';
import { encryptPrivateKey, decryptPrivateKey } from './encryption.service';

const BALANCE_CACHE_TTL = 30; // seconds
const BALANCE_CACHE_PREFIX = 'wallet:balance:';

export interface WalletInfo {
  walletId: string;
  agentId: string;
  address: string;
  balance: string; // ETH as string
  createdAt: Date;
}

export interface SignedTransaction {
  signedTx: string;
  txHash: string;
}

export interface TransactionParams {
  to: string;
  value: string; // Wei as string
  data?: string;
  gasLimit?: string;
  nonce?: number;
}

export interface PaginatedTransactions {
  transactions: WalletTransaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class WalletService {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly provider: ethers.JsonRpcProvider;

  constructor(prisma: PrismaClient, redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;

    const rpcUrl = process.env['BLOCKCHAIN_RPC_URL'];
    if (!rpcUrl) {
      throw new Error('BLOCKCHAIN_RPC_URL environment variable is required');
    }
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Generates a new hot wallet for an AI agent.
   * The private key is encrypted immediately and the plaintext is never persisted.
   * Returns only the public address - private key is never returned.
   */
  async generateWallet(agentId: string): Promise<{ agentId: string; address: string; walletId: string }> {
    // Check if agent already has a wallet
    const existing = await this.prisma.wallet.findUnique({
      where: { agentId },
    });

    if (existing) {
      throw new Error(`Wallet already exists for agent ${agentId}`);
    }

    // Generate new wallet using ethers
    const wallet = ethers.Wallet.createRandom();
    const privateKey = wallet.privateKey;

    // Encrypt immediately - private key exists in plaintext only transiently here
    const encryptedPrivKey = encryptPrivateKey(privateKey);

    // Store encrypted wallet in DB
    const record = await this.prisma.wallet.create({
      data: {
        agentId,
        address: wallet.address.toLowerCase(),
        encryptedPrivKey,
      },
    });

    logger.info('Hot wallet generated', {
      agentId,
      address: wallet.address,
      walletId: record.walletId,
    });

    return {
      agentId: record.agentId,
      address: record.address,
      walletId: record.walletId,
    };
  }

  /**
   * Gets wallet info including current on-chain balance.
   */
  async getWalletInfo(agentId: string): Promise<WalletInfo> {
    const wallet = await this.getWalletRecord(agentId);
    const balance = await this.getBalance(agentId);

    return {
      walletId: wallet.walletId,
      agentId: wallet.agentId,
      address: wallet.address,
      balance,
      createdAt: wallet.createdAt,
    };
  }

  /**
   * Returns current on-chain ETH balance for the agent's wallet.
   * Cached in Redis for 30 seconds.
   */
  async getBalance(agentId: string): Promise<string> {
    const cacheKey = `${BALANCE_CACHE_PREFIX}${agentId}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return cached;
    }

    const wallet = await this.getWalletRecord(agentId);
    const balanceWei = await this.provider.getBalance(wallet.address);
    const balanceEth = ethers.formatEther(balanceWei);

    await this.redis.setex(cacheKey, BALANCE_CACHE_TTL, balanceEth);

    return balanceEth;
  }

  /**
   * Signs a transaction using the agent's private key.
   * This is an INTERNAL-ONLY operation. The private key is:
   *   1. Decrypted transiently in memory
   *   2. Used to sign the transaction
   *   3. The signer is destroyed immediately after
   *
   * SECURITY: This function is gated by INTERNAL_API_SECRET in the route layer.
   * The private key is NEVER logged, returned, or persisted in plaintext.
   */
  async signTransaction(agentId: string, txParams: TransactionParams): Promise<SignedTransaction> {
    const walletRecord = await this.getWalletRecord(agentId);

    // Decrypt private key transiently
    let privateKeyPlaintext: string;
    try {
      privateKeyPlaintext = decryptPrivateKey(walletRecord.encryptedPrivKey);
    } catch (err) {
      logger.error('Failed to decrypt private key', { agentId, error: err });
      throw new Error('Failed to decrypt wallet credentials');
    }

    let signedTx: string;
    let txHash: string;

    try {
      const signer = new ethers.Wallet(privateKeyPlaintext, this.provider);

      // Resolve nonce if not provided
      const nonce = txParams.nonce ?? await this.provider.getTransactionCount(signer.address, 'pending');

      // Get current gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? ethers.parseUnits('20', 'gwei');

      // Estimate gas if not provided
      let gasLimit: bigint;
      if (txParams.gasLimit) {
        gasLimit = BigInt(txParams.gasLimit);
      } else {
        try {
          gasLimit = await this.provider.estimateGas({
            to: txParams.to,
            value: BigInt(txParams.value),
            data: txParams.data ?? '0x',
            from: signer.address,
          });
          // Add 20% buffer
          gasLimit = (gasLimit * 120n) / 100n;
        } catch {
          gasLimit = 21000n;
        }
      }

      const tx: ethers.TransactionRequest = {
        to: txParams.to,
        value: BigInt(txParams.value),
        data: txParams.data ?? '0x',
        gasLimit,
        gasPrice,
        nonce,
        chainId: (await this.provider.getNetwork()).chainId,
      };

      signedTx = await signer.signTransaction(tx);
      const parsedTx = ethers.Transaction.from(signedTx);
      txHash = parsedTx.hash ?? ethers.keccak256(Buffer.from(signedTx.slice(2), 'hex'));
    } finally {
      // Zero out private key from memory
      privateKeyPlaintext = '0'.repeat(privateKeyPlaintext.length);
    }

    // Record transaction in DB
    await this.prisma.walletTransaction.create({
      data: {
        walletId: walletRecord.walletId,
        txHash,
        type: 'SEND',
        amount: txParams.value,
        toAddress: txParams.to,
        fromAddress: walletRecord.address,
        status: 'SIGNED',
      },
    });

    logger.info('Transaction signed', {
      agentId,
      txHash,
      to: txParams.to,
      value: txParams.value,
    });

    return { signedTx, txHash };
  }

  /**
   * Gets paginated transaction history for an agent's wallet.
   */
  async getTransactionHistory(agentId: string, page: number, limit: number): Promise<PaginatedTransactions> {
    const wallet = await this.getWalletRecord(agentId);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: wallet.walletId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.walletTransaction.count({
        where: { walletId: wallet.walletId },
      }),
    ]);

    return {
      transactions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Updates a transaction record status (used by external broadcast service).
   */
  async updateTransactionStatus(
    txHash: string,
    status: string,
    blockNumber?: bigint,
    gasUsed?: string
  ): Promise<void> {
    await this.prisma.walletTransaction.updateMany({
      where: { txHash },
      data: {
        status,
        blockNumber: blockNumber ?? null,
        gasUsed: gasUsed ?? null,
      },
    });
  }

  private async getWalletRecord(agentId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { agentId },
    });

    if (!wallet) {
      throw new Error(`No wallet found for agent ${agentId}`);
    }

    return wallet;
  }
}
