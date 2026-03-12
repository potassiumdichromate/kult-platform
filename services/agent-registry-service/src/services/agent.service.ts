import { PrismaClient, AgentStatus, Agent } from '@prisma/client';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { winstonLogger } from '../logger';
import { blockchainService } from './blockchain.service';

export interface CreateAgentInput {
  ownerWallet: string;
  hotWalletAddress?: string;
  modelHash?: string;
}

export interface UpdateELOInput {
  agentId: string;
  newRating: number;
  change: number;
  reason?: string;
}

export interface LeaderboardEntry {
  agentId: string;
  ownerWallet: string;
  eloRating: number;
  reputationScore: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  rank: number;
}

const AGENT_CACHE_PREFIX = 'agent:';
const LEADERBOARD_CACHE_KEY = 'leaderboard:top';
const AGENT_CACHE_TTL = parseInt(process.env.AGENT_CACHE_TTL || '60', 10);
const LEADERBOARD_CACHE_TTL = parseInt(
  process.env.LEADERBOARD_CACHE_TTL || '30',
  10
);
const LEADERBOARD_SIZE = parseInt(process.env.LEADERBOARD_SIZE || '100', 10);

export class AgentService {
  private prisma: PrismaClient;
  private redis: Redis;
  private eventQueue: Queue;

  constructor(prisma: PrismaClient, redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
    this.eventQueue = new Queue(
      process.env.AGENT_EVENTS_QUEUE || 'agent-events',
      {
        connection: redis,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }
    );
  }

  /**
   * Creates a new agent, persists it to the database, registers it on-chain,
   * and emits a creation event.
   */
  async createAgent(data: CreateAgentInput): Promise<Agent> {
    const normalizedWallet = data.ownerWallet.toLowerCase();

    // Validate wallet format
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedWallet)) {
      throw new Error('Invalid owner wallet address format.');
    }

    // Create in database first to get the agentId
    const agent = await this.prisma.agent.create({
      data: {
        ownerWallet: normalizedWallet,
        hotWalletAddress: data.hotWalletAddress?.toLowerCase() || null,
        modelHash: data.modelHash || null,
        status: AgentStatus.ACTIVE,
      },
    });

    winstonLogger.info('Agent created in database', {
      agentId: agent.agentId,
      ownerWallet: normalizedWallet,
    });

    // Register on-chain (non-blocking, errors are logged but don't fail the API)
    blockchainService
      .registerAgentOnChain(agent.agentId, normalizedWallet)
      .then(({ txHash, simulated }) => {
        winstonLogger.info('Agent registered on-chain', {
          agentId: agent.agentId,
          txHash,
          simulated,
        });
      })
      .catch((err: Error) => {
        winstonLogger.error('Failed to register agent on-chain', {
          agentId: agent.agentId,
          error: err.message,
        });
      });

    // Emit creation event
    await this.emitEvent('agent.created', {
      agentId: agent.agentId,
      ownerWallet: normalizedWallet,
      createdAt: agent.createdAt.toISOString(),
    });

    // Cache the new agent
    await this.cacheAgent(agent);

    return agent;
  }

  /**
   * Retrieves an agent by ID, preferring the Redis cache over the database.
   */
  async getAgent(agentId: string): Promise<Agent | null> {
    // Try cache first
    const cached = await this.redis.get(`${AGENT_CACHE_PREFIX}${agentId}`);
    if (cached) {
      try {
        return JSON.parse(cached) as Agent;
      } catch {
        // Cache corrupted; fall through to DB
        await this.redis.del(`${AGENT_CACHE_PREFIX}${agentId}`);
      }
    }

    // Fall back to database
    const agent = await this.prisma.agent.findUnique({
      where: { agentId },
    });

    if (agent) {
      await this.cacheAgent(agent);
    }

    return agent;
  }

  /**
   * Returns all agents belonging to a given wallet address.
   */
  async getAgentsByOwner(ownerWallet: string): Promise<Agent[]> {
    const normalizedWallet = ownerWallet.toLowerCase();
    return this.prisma.agent.findMany({
      where: { ownerWallet: normalizedWallet },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Updates the ELO rating of an agent, writes to elo_history, invalidates cache,
   * and emits an event.
   */
  async updateELO(input: UpdateELOInput): Promise<Agent> {
    const { agentId, newRating, change, reason } = input;

    const existing = await this.prisma.agent.findUnique({
      where: { agentId },
    });

    if (!existing) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const agent = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.agent.update({
        where: { agentId },
        data: {
          eloRating: newRating,
          wins: change > 0 ? { increment: 1 } : undefined,
          losses: change < 0 ? { increment: 1 } : undefined,
          gamesPlayed: { increment: 1 },
        },
      });
      await tx.eloHistory.create({
        data: {
          agentId,
          oldRating: existing.eloRating,
          newRating,
          change,
          reason: reason ?? null,
        },
      });
      return updated;
    });

    // Invalidate agent cache
    await this.invalidateAgentCache(agentId);
    // Invalidate leaderboard cache
    await this.redis.del(LEADERBOARD_CACHE_KEY);

    winstonLogger.info('Agent ELO updated', {
      agentId,
      oldRating: existing.eloRating,
      newRating,
      change,
    });

    await this.emitEvent('agent.elo_updated', {
      agentId,
      ownerWallet: agent.ownerWallet,
      oldRating: existing.eloRating,
      newRating,
      change,
      timestamp: new Date().toISOString(),
    });

    // Re-cache updated agent
    await this.cacheAgent(agent);

    return agent;
  }

  /**
   * Updates the model hash of an agent (points to new AI model version).
   */
  async updateModelHash(agentId: string, modelHash: string): Promise<Agent> {
    const agent = await this.prisma.agent.update({
      where: { agentId },
      data: { modelHash },
    });

    await this.invalidateAgentCache(agentId);
    await this.cacheAgent(agent);

    winstonLogger.info('Agent model hash updated', { agentId, modelHash });

    await this.emitEvent('agent.model_updated', {
      agentId,
      modelHash,
      timestamp: new Date().toISOString(),
    });

    return agent;
  }

  /**
   * Updates the status of an agent (ACTIVE, INACTIVE, SUSPENDED, TRAINING).
   */
  async updateStatus(agentId: string, status: AgentStatus): Promise<Agent> {
    const agent = await this.prisma.agent.update({
      where: { agentId },
      data: { status },
    });

    await this.invalidateAgentCache(agentId);
    await this.cacheAgent(agent);

    winstonLogger.info('Agent status updated', { agentId, status });

    await this.emitEvent('agent.status_updated', {
      agentId,
      status,
      timestamp: new Date().toISOString(),
    });

    return agent;
  }

  /**
   * Marks an agent as SUSPENDED and emits a suspension event.
   */
  async suspendAgent(agentId: string): Promise<Agent> {
    return this.updateStatus(agentId, AgentStatus.SUSPENDED);
  }

  /**
   * Soft-deletes an agent by marking it INACTIVE.
   */
  async deactivateAgent(agentId: string): Promise<Agent> {
    return this.updateStatus(agentId, AgentStatus.INACTIVE);
  }

  /**
   * Returns the top N agents by ELO rating, cached in Redis.
   */
  async getLeaderboard(
    limit: number = LEADERBOARD_SIZE,
    offset: number = 0
  ): Promise<LeaderboardEntry[]> {
    const cacheKey = `${LEADERBOARD_CACHE_KEY}:${limit}:${offset}`;

    // Try cache for first page only
    if (offset === 0) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LeaderboardEntry[];
        } catch {
          await this.redis.del(cacheKey);
        }
      }
    }

    const agents = await this.prisma.agent.findMany({
      where: { status: AgentStatus.ACTIVE },
      orderBy: [{ eloRating: 'desc' }, { wins: 'desc' }],
      take: Math.min(limit, LEADERBOARD_SIZE),
      skip: offset,
      select: {
        agentId: true,
        ownerWallet: true,
        eloRating: true,
        reputationScore: true,
        gamesPlayed: true,
        wins: true,
        losses: true,
      },
    });

    const entries: LeaderboardEntry[] = agents.map((agent, idx) => ({
      ...agent,
      rank: offset + idx + 1,
    }));

    // Cache first page
    if (offset === 0) {
      await this.redis.setex(cacheKey, LEADERBOARD_CACHE_TTL, JSON.stringify(entries));
    }

    return entries;
  }

  /**
   * Updates the hot wallet address both in the DB and on-chain.
   */
  async updateHotWallet(
    agentId: string,
    hotWalletAddress: string
  ): Promise<Agent> {
    const normalizedHotWallet = hotWalletAddress.toLowerCase();

    if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedHotWallet)) {
      throw new Error('Invalid hot wallet address format.');
    }

    const agent = await this.prisma.agent.update({
      where: { agentId },
      data: { hotWalletAddress: normalizedHotWallet },
    });

    await this.invalidateAgentCache(agentId);
    await this.cacheAgent(agent);

    // Update on-chain non-blocking
    blockchainService
      .updateHotWallet(agentId, normalizedHotWallet)
      .then(({ txHash, simulated }) => {
        winstonLogger.info('Hot wallet updated on-chain', {
          agentId,
          txHash,
          simulated,
        });
      })
      .catch((err: Error) => {
        winstonLogger.error('Failed to update hot wallet on-chain', {
          agentId,
          error: err.message,
        });
      });

    await this.emitEvent('agent.hot_wallet_updated', {
      agentId,
      hotWalletAddress: normalizedHotWallet,
      timestamp: new Date().toISOString(),
    });

    return agent;
  }

  private async cacheAgent(agent: Agent): Promise<void> {
    await this.redis.setex(
      `${AGENT_CACHE_PREFIX}${agent.agentId}`,
      AGENT_CACHE_TTL,
      JSON.stringify(agent)
    );
  }

  private async invalidateAgentCache(agentId: string): Promise<void> {
    await this.redis.del(`${AGENT_CACHE_PREFIX}${agentId}`);
  }

  private async emitEvent(
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.eventQueue.add(eventType, {
        event: eventType,
        payload,
        timestamp: new Date().toISOString(),
      });

      // Also publish to Redis pub/sub for real-time WebSocket delivery
      await this.redis.publish(
        'agent-events',
        JSON.stringify({ event: eventType, payload })
      );
    } catch (err) {
      winstonLogger.error('Failed to emit agent event', {
        eventType,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}
