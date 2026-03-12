import { PrismaClient } from '@prisma/client';
import { ethers } from 'ethers';
import axios from 'axios';
import { CONTRACT_WHITELIST, TX_TYPE_TO_CONTRACT, isContractWhitelisted } from '../config/whitelist';
import { logger } from '../middleware/logger';

export interface TransactionRequest {
  agentId: string;
  type: string;
  weaponId?: string;
  amount: string; // ETH as decimal string e.g. "0.005"
  targetContract?: string;
  calldata?: string;
}

export interface PolicyResult {
  approved: boolean;
  reason: string;
  checks: PolicyCheckResult[];
  targetContract?: string;
  resolvedMethod?: string;
  gasEstimate?: string;
}

export interface PolicyCheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

const WALLET_SERVICE_URL = process.env['WALLET_SERVICE_URL'] ?? 'http://wallet-service:3002';

export class PolicyService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Full policy evaluation pipeline.
   * All checks must pass for the transaction to be approved.
   */
  async evaluatePolicy(txRequest: TransactionRequest): Promise<PolicyResult> {
    const checks: PolicyCheckResult[] = [];
    const { agentId, type, amount } = txRequest;

    // Resolve target contract and method from transaction type
    const txMapping = TX_TYPE_TO_CONTRACT[type];
    if (!txMapping) {
      return {
        approved: false,
        reason: `Unknown transaction type: ${type}`,
        checks: [
          {
            check: 'TYPE_RESOLUTION',
            passed: false,
            detail: `Transaction type '${type}' is not recognized`,
          },
        ],
      };
    }

    const contractEntry = CONTRACT_WHITELIST[txMapping.contractKey];
    if (!contractEntry) {
      return {
        approved: false,
        reason: `No contract configured for type ${type}`,
        checks: [
          {
            check: 'CONTRACT_RESOLUTION',
            passed: false,
            detail: `Contract key '${txMapping.contractKey}' not found in whitelist`,
          },
        ],
      };
    }

    const targetContract = txRequest.targetContract ?? contractEntry.address;
    const resolvedMethod = txMapping.method;

    // Check 1: Contract whitelist
    const whitelistPassed = isContractWhitelisted(targetContract, resolvedMethod);
    checks.push({
      check: 'CONTRACT_WHITELIST',
      passed: whitelistPassed,
      detail: whitelistPassed
        ? `Contract ${targetContract} with method ${resolvedMethod} is whitelisted`
        : `Contract ${targetContract} or method ${resolvedMethod} is NOT whitelisted`,
    });

    if (!whitelistPassed) {
      return {
        approved: false,
        reason: 'Target contract or method is not whitelisted',
        checks,
        targetContract,
        resolvedMethod,
      };
    }

    // Check 2: Parse and validate amount
    let amountWei: bigint;
    try {
      amountWei = ethers.parseEther(amount);
    } catch {
      checks.push({
        check: 'AMOUNT_PARSE',
        passed: false,
        detail: `Cannot parse amount '${amount}' as ETH value`,
      });
      return { approved: false, reason: 'Invalid amount format', checks };
    }
    checks.push({
      check: 'AMOUNT_PARSE',
      passed: true,
      detail: `Amount ${amount} ETH (${amountWei.toString()} wei) parsed successfully`,
    });

    // Get spending limits for agent
    const spendingLimit = await this.getOrCreateSpendingLimit(agentId);

    // Check 3: Per-transaction limit
    const perTxLimitWei = ethers.parseEther(spendingLimit.perTxLimit);
    const perTxPassed = amountWei <= perTxLimitWei;
    checks.push({
      check: 'PER_TX_LIMIT',
      passed: perTxPassed,
      detail: perTxPassed
        ? `Amount ${amount} ETH is within per-tx limit of ${spendingLimit.perTxLimit} ETH`
        : `Amount ${amount} ETH exceeds per-tx limit of ${spendingLimit.perTxLimit} ETH`,
    });

    if (!perTxPassed) {
      return {
        approved: false,
        reason: `Transaction amount exceeds per-transaction limit of ${spendingLimit.perTxLimit} ETH`,
        checks,
        targetContract,
        resolvedMethod,
      };
    }

    // Check 4: Daily spending limit
    const now = new Date();
    const needsReset = spendingLimit.resetAt <= now;
    const currentSpentToday = needsReset ? '0' : spendingLimit.spentToday;

    const spentTodayWei = ethers.parseEther(currentSpentToday);
    const dailyLimitWei = ethers.parseEther(spendingLimit.dailyLimit);
    const projectedSpend = spentTodayWei + amountWei;
    const dailyPassed = projectedSpend <= dailyLimitWei;

    checks.push({
      check: 'DAILY_LIMIT',
      passed: dailyPassed,
      detail: dailyPassed
        ? `Projected daily spend ${ethers.formatEther(projectedSpend)} ETH within limit of ${spendingLimit.dailyLimit} ETH`
        : `Projected daily spend ${ethers.formatEther(projectedSpend)} ETH exceeds limit of ${spendingLimit.dailyLimit} ETH`,
    });

    if (!dailyPassed) {
      return {
        approved: false,
        reason: `Transaction would exceed daily spending limit of ${spendingLimit.dailyLimit} ETH`,
        checks,
        targetContract,
        resolvedMethod,
      };
    }

    // Check 5: Sufficient balance from wallet service
    let balancePassed = false;
    let balanceDetail = '';
    try {
      const balanceResponse = await axios.get(
        `${WALLET_SERVICE_URL}/wallet/${agentId}/balance`,
        { timeout: 5000 }
      );
      const balanceEth: string = balanceResponse.data.data.balance;
      const balanceWei = ethers.parseEther(balanceEth);

      // Require balance to cover amount + estimated gas buffer (0.002 ETH)
      const gasBuffer = ethers.parseEther('0.002');
      const required = amountWei + gasBuffer;
      balancePassed = balanceWei >= required;
      balanceDetail = balancePassed
        ? `Balance ${balanceEth} ETH is sufficient for ${amount} ETH + gas`
        : `Balance ${balanceEth} ETH is insufficient for ${amount} ETH + gas buffer`;
    } catch (err) {
      balanceDetail = `Failed to fetch balance from wallet service: ${err instanceof Error ? err.message : 'Unknown error'}`;
      balancePassed = false;
    }

    checks.push({
      check: 'BALANCE_CHECK',
      passed: balancePassed,
      detail: balanceDetail,
    });

    if (!balancePassed) {
      return {
        approved: false,
        reason: 'Insufficient balance',
        checks,
        targetContract,
        resolvedMethod,
      };
    }

    logger.info('Policy evaluation passed', {
      agentId,
      type,
      amount,
      targetContract,
      resolvedMethod,
    });

    return {
      approved: true,
      reason: 'All policy checks passed',
      checks,
      targetContract,
      resolvedMethod,
    };
  }

  /**
   * Gets or creates the spending limit record for an agent.
   * Creates with defaults if not existing.
   */
  async getOrCreateSpendingLimit(agentId: string): Promise<{
    limitId: string;
    agentId: string;
    dailyLimit: string;
    perTxLimit: string;
    spentToday: string;
    resetAt: Date;
  }> {
    const existing = await this.prisma.spendingLimit.findUnique({
      where: { agentId },
    });

    if (existing) {
      return existing;
    }

    // Create default spending limits - reset at midnight UTC next day
    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);

    return this.prisma.spendingLimit.create({
      data: {
        agentId,
        dailyLimit: process.env['DEFAULT_DAILY_LIMIT'] ?? '0.1',
        perTxLimit: process.env['DEFAULT_PER_TX_LIMIT'] ?? '0.01',
        spentToday: '0',
        resetAt,
      },
    });
  }

  /**
   * Atomically resets daily spending counter if the reset window has passed.
   */
  async resetDailySpendingIfNeeded(agentId: string): Promise<void> {
    const limit = await this.prisma.spendingLimit.findUnique({ where: { agentId } });
    if (!limit) return;

    const now = new Date();
    if (limit.resetAt <= now) {
      const nextReset = new Date();
      nextReset.setUTCHours(24, 0, 0, 0);

      await this.prisma.spendingLimit.update({
        where: { agentId },
        data: {
          spentToday: '0',
          resetAt: nextReset,
        },
      });

      logger.info('Daily spending limit reset', { agentId });
    }
  }
}
