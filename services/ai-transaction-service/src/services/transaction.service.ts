import { PrismaClient, AITransaction } from '@prisma/client';
import { ethers } from 'ethers';
import axios from 'axios';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { PolicyService, TransactionRequest } from './policy.service';
import { logger } from '../middleware/logger';

const WALLET_SERVICE_URL = process.env['WALLET_SERVICE_URL'] ?? 'http://wallet-service:3002';
const INTERNAL_API_SECRET = process.env['INTERNAL_API_SECRET'] ?? '';

const TX_QUEUE_NAME = 'ai-transactions';
const SPENDING_REDIS_PREFIX = 'spending:today:';
const SPENDING_REDIS_TTL = 86400; // 24 hours in seconds

export interface RequestTransactionInput {
  agentId: string;
  type: string;
  weaponId?: string;
  amount: string; // ETH decimal
  calldata?: string;
}

export interface TransactionRequestResult {
  txId: string;
  policyResult: {
    approved: boolean;
    reason: string;
    checks: Array<{ check: string; passed: boolean; detail: string }>;
  };
  status: string;
}

export interface SpendingStats {
  agentId: string;
  spentToday: string;
  dailyLimit: string;
  perTxLimit: string;
  remaining: string;
  resetAt: Date;
  percentUsed: number;
}

export class TransactionService {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly policyService: PolicyService;
  private readonly txQueue: Queue;
  private readonly provider: ethers.JsonRpcProvider;

  constructor(prisma: PrismaClient, redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
    this.policyService = new PolicyService(prisma);
    this.txQueue = new Queue(TX_QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    });

    const rpcUrl = process.env['BLOCKCHAIN_RPC_URL'];
    if (!rpcUrl) {
      throw new Error('BLOCKCHAIN_RPC_URL environment variable is required');
    }
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  /**
   * Processes an AI agent transaction request through the policy engine.
   * If approved, creates a DB record and queues for asynchronous execution.
   */
  async requestTransaction(input: RequestTransactionInput): Promise<TransactionRequestResult> {
    const { agentId, type, weaponId, amount } = input;

    const txRequest: TransactionRequest = {
      agentId,
      type,
      weaponId,
      amount,
    };

    // Run policy engine
    const policyResult = await this.policyService.evaluatePolicy(txRequest);

    // Build calldata based on type
    const calldata = input.calldata ?? this.buildCalldata(type, weaponId, amount);

    // Create transaction record
    const tx = await this.prisma.aITransaction.create({
      data: {
        agentId,
        type,
        amount,
        targetContract: policyResult.targetContract ?? '',
        calldata,
        status: policyResult.approved ? 'QUEUED' : 'REJECTED',
        policyApproved: policyResult.approved,
        policyReason: policyResult.reason,
      },
    });

    if (policyResult.approved) {
      // Queue for async execution
      await this.txQueue.add(
        'execute-transaction',
        { txId: tx.txId },
        { jobId: tx.txId }
      );

      logger.info('Transaction approved and queued', {
        txId: tx.txId,
        agentId,
        type,
        amount,
      });
    } else {
      logger.warn('Transaction rejected by policy engine', {
        txId: tx.txId,
        agentId,
        type,
        reason: policyResult.reason,
      });
    }

    return {
      txId: tx.txId,
      policyResult: {
        approved: policyResult.approved,
        reason: policyResult.reason,
        checks: policyResult.checks,
      },
      status: tx.status,
    };
  }

  /**
   * Executes a queued transaction: calls wallet service to sign, broadcasts to blockchain.
   * Called by the BullMQ worker.
   */
  async executeTransaction(txId: string): Promise<void> {
    const tx = await this.prisma.aITransaction.findUnique({ where: { txId } });
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (!tx.policyApproved) {
      throw new Error(`Transaction ${txId} was not approved by policy engine`);
    }

    // Update status to EXECUTING
    await this.prisma.aITransaction.update({
      where: { txId },
      data: { status: 'EXECUTING' },
    });

    try {
      // Get amount in wei
      const amountWei = ethers.parseEther(tx.amount).toString();

      // Call wallet service internal sign endpoint
      const signResponse = await axios.post(
        `${WALLET_SERVICE_URL}/wallet/sign`,
        {
          agentId: tx.agentId,
          to: tx.targetContract,
          value: amountWei,
          data: tx.calldata,
        },
        {
          headers: { 'x-internal-secret': INTERNAL_API_SECRET },
          timeout: 15000,
        }
      );

      const { signedTx, txHash } = signResponse.data.data as { signedTx: string; txHash: string };

      // Broadcast to blockchain
      await this.provider.broadcastTransaction(signedTx);

      // Update DB with tx hash
      await this.prisma.aITransaction.update({
        where: { txId },
        data: { txHash, status: 'BROADCAST' },
      });

      // Update spending tracker
      await this.updateSpendingTracker(tx.agentId, tx.amount);

      logger.info('Transaction broadcast', { txId, txHash, agentId: tx.agentId });

      // Track confirmation asynchronously
      this.trackTransaction(txHash, txId).catch((err) => {
        logger.error('Error tracking transaction confirmation', { txId, txHash, err });
      });
    } catch (err) {
      logger.error('Transaction execution failed', { txId, err });

      await this.prisma.aITransaction.update({
        where: { txId },
        data: {
          status: 'FAILED',
          policyReason: err instanceof Error ? err.message : 'Execution failed',
        },
      });

      throw err;
    }
  }

  /**
   * Polls blockchain for transaction confirmation.
   * Updates DB on confirmation with block number.
   */
  async trackTransaction(txHash: string, txId: string): Promise<void> {
    const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_INTERVAL_MS = 5000;
    const REQUIRED_CONFIRMATIONS = 3;

    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT_MS) {
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash);

        if (receipt) {
          const currentBlock = await this.provider.getBlockNumber();
          const confirmations = currentBlock - Number(receipt.blockNumber) + 1;

          if (confirmations >= REQUIRED_CONFIRMATIONS) {
            const status = receipt.status === 1 ? 'CONFIRMED' : 'REVERTED';

            await this.prisma.aITransaction.update({
              where: { txId },
              data: {
                status,
                blockConfirmed: Number(receipt.blockNumber),
                gasEstimate: receipt.gasUsed.toString(),
              },
            });

            logger.info('Transaction confirmed', {
              txId,
              txHash,
              status,
              blockNumber: receipt.blockNumber,
              confirmations,
            });
            return;
          }
        }
      } catch (err) {
        logger.warn('Error polling transaction', { txHash, err });
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Mark as unconfirmed after timeout - may still confirm later
    await this.prisma.aITransaction.update({
      where: { txId },
      data: { status: 'UNCONFIRMED' },
    });

    logger.warn('Transaction confirmation timeout', { txId, txHash });
  }

  /**
   * Atomically updates the spending tracker in both Redis (fast) and DB (durable).
   * Uses Redis for real-time checking during policy evaluation.
   */
  async updateSpendingTracker(agentId: string, amountEth: string): Promise<void> {
    const redisKey = `${SPENDING_REDIS_PREFIX}${agentId}`;

    // Get current and add new amount
    const currentStr = await this.redis.get(redisKey);
    const current = currentStr ? parseFloat(currentStr) : 0;
    const additional = parseFloat(amountEth);
    const newTotal = current + additional;

    // Atomic set with TTL
    await this.redis.setex(redisKey, SPENDING_REDIS_TTL, newTotal.toFixed(18));

    // Also update DB
    await this.policyService.resetDailySpendingIfNeeded(agentId);

    await this.prisma.spendingLimit.upsert({
      where: { agentId },
      create: {
        agentId,
        spentToday: amountEth,
        dailyLimit: process.env['DEFAULT_DAILY_LIMIT'] ?? '0.1',
        perTxLimit: process.env['DEFAULT_PER_TX_LIMIT'] ?? '0.01',
        resetAt: new Date(Date.now() + 86400000),
      },
      update: {
        spentToday: newTotal.toFixed(18),
      },
    });

    logger.info('Spending tracker updated', { agentId, amountEth, totalToday: newTotal });
  }

  /**
   * Gets today's spending stats for an agent.
   */
  async getSpendingStats(agentId: string): Promise<SpendingStats> {
    await this.policyService.resetDailySpendingIfNeeded(agentId);
    const limit = await this.policyService.getOrCreateSpendingLimit(agentId);

    const spent = parseFloat(limit.spentToday);
    const daily = parseFloat(limit.dailyLimit);
    const remaining = Math.max(0, daily - spent);
    const percentUsed = daily > 0 ? (spent / daily) * 100 : 0;

    return {
      agentId,
      spentToday: limit.spentToday,
      dailyLimit: limit.dailyLimit,
      perTxLimit: limit.perTxLimit,
      remaining: remaining.toFixed(18),
      resetAt: limit.resetAt,
      percentUsed: Math.round(percentUsed * 100) / 100,
    };
  }

  async getTransaction(txId: string): Promise<AITransaction | null> {
    return this.prisma.aITransaction.findUnique({ where: { txId } });
  }

  async getAgentTransactions(
    agentId: string,
    page: number,
    limit: number
  ): Promise<{ transactions: AITransaction[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      this.prisma.aITransaction.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.aITransaction.count({ where: { agentId } }),
    ]);

    return { transactions, total, page, totalPages: Math.ceil(total / limit) };
  }

  async retryTransaction(txId: string): Promise<void> {
    const tx = await this.prisma.aITransaction.findUnique({ where: { txId } });
    if (!tx) {
      throw new Error(`Transaction ${txId} not found`);
    }

    if (tx.status !== 'FAILED' && tx.status !== 'UNCONFIRMED') {
      throw new Error(`Transaction ${txId} is in status '${tx.status}' and cannot be retried`);
    }

    await this.prisma.aITransaction.update({
      where: { txId },
      data: { status: 'QUEUED' },
    });

    await this.txQueue.add('execute-transaction', { txId }, { jobId: `retry-${txId}-${Date.now()}` });

    logger.info('Transaction queued for retry', { txId });
  }

  /**
   * Builds ABI-encoded calldata for known transaction types.
   */
  private buildCalldata(type: string, weaponId?: string, _amount?: string): string {
    const iface = new ethers.Interface([
      'function buyWeapon(uint256 weaponId)',
      'function upgradeWeapon(uint256 weaponId)',
      'function deposit()',
    ]);

    try {
      switch (type) {
        case 'BUY_WEAPON':
          if (!weaponId) return '0x';
          return iface.encodeFunctionData('buyWeapon', [BigInt(weaponId)]);
        case 'UPGRADE_WEAPON':
          if (!weaponId) return '0x';
          return iface.encodeFunctionData('upgradeWeapon', [BigInt(weaponId)]);
        case 'TREASURY_DEPOSIT':
          return iface.encodeFunctionData('deposit', []);
        default:
          return '0x';
      }
    } catch {
      return '0x';
    }
  }
}
