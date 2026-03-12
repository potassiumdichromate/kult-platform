import Redis from 'ioredis';
import { Logger } from 'winston';

// ─── Redis key helpers ────────────────────────────────────────────────────────

const QUEUE_KEY = (gameMode: string) => `arena:queue:${gameMode}`;
const AGENT_QUEUE_META_KEY = (agentId: string) => `arena:agent:${agentId}:queue`;
const QUEUE_TTL_SECONDS = 300; // Remove stale entries after 5 minutes

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueueEntry {
  agentId: string;
  eloRating: number;
  gameMode: string;
  joinedAt: number; // Unix timestamp ms
  priorityScore: number;
}

export interface QueuePosition {
  position: number;
  totalInQueue: number;
  estimatedWaitMs: number;
}

// ─── Queue Service ────────────────────────────────────────────────────────────

export class QueueService {
  /**
   * We store agents in a Redis Sorted Set keyed by game mode.
   * Score = joinedAt timestamp (lower = waited longer = higher priority).
   * Metadata (eloRating, gameMode) is stored in a separate hash key per agent.
   */

  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger
  ) {}

  /**
   * Add an agent to the matchmaking queue.
   * If agent is already in a queue, update their entry.
   */
  async joinQueue(agentId: string, eloRating: number, gameMode: string): Promise<QueuePosition> {
    const now = Date.now();
    const queueKey = QUEUE_KEY(gameMode);
    const metaKey = AGENT_QUEUE_META_KEY(agentId);

    // Check if agent is already in any queue
    const existingMeta = await this.redis.hgetall(metaKey);
    if (existingMeta.gameMode && existingMeta.gameMode !== gameMode) {
      // Remove from old queue before joining new one
      await this.redis.zrem(QUEUE_KEY(existingMeta.gameMode), agentId);
    }

    // Add to sorted set with joinedAt as score
    const pipeline = this.redis.pipeline();
    pipeline.zadd(queueKey, now, agentId);
    pipeline.expire(queueKey, QUEUE_TTL_SECONDS);

    // Store agent metadata in a hash with TTL
    pipeline.hset(metaKey, {
      agentId,
      eloRating: eloRating.toString(),
      gameMode,
      joinedAt: now.toString(),
    });
    pipeline.expire(metaKey, QUEUE_TTL_SECONDS);

    await pipeline.exec();

    this.logger.info('Agent joined queue', { agentId, eloRating, gameMode });

    return this.getQueuePosition(agentId, gameMode);
  }

  /**
   * Remove an agent from all queues.
   */
  async leaveQueue(agentId: string): Promise<boolean> {
    const metaKey = AGENT_QUEUE_META_KEY(agentId);
    const meta = await this.redis.hgetall(metaKey);

    if (!meta.gameMode) {
      this.logger.debug('Agent not in queue', { agentId });
      return false;
    }

    const pipeline = this.redis.pipeline();
    pipeline.zrem(QUEUE_KEY(meta.gameMode), agentId);
    pipeline.del(metaKey);
    await pipeline.exec();

    this.logger.info('Agent left queue', { agentId, gameMode: meta.gameMode });
    return true;
  }

  /**
   * Get all queued agents for a game mode, ordered by join time (oldest first).
   * Returns their full metadata.
   */
  async getQueuedAgents(gameMode: string): Promise<QueueEntry[]> {
    const queueKey = QUEUE_KEY(gameMode);

    // Get agents sorted by score (joinedAt, lowest = oldest)
    const members = await this.redis.zrangebyscore(queueKey, '-inf', '+inf', 'WITHSCORES');

    if (members.length === 0) return [];

    const now = Date.now();
    const entries: QueueEntry[] = [];

    // members is alternating [agentId, score, agentId, score, ...]
    for (let i = 0; i < members.length; i += 2) {
      const agentId = members[i];
      const joinedAt = parseFloat(members[i + 1] ?? '0');

      if (!agentId) continue;

      const metaKey = AGENT_QUEUE_META_KEY(agentId);
      const meta = await this.redis.hgetall(metaKey);

      // Check for stale entries (agent metadata expired but sorted set still has them)
      if (!meta.eloRating) {
        // Stale - remove from sorted set
        await this.redis.zrem(queueKey, agentId);
        continue;
      }

      const waitTimeMs = now - joinedAt;

      // Priority score: higher wait time = lower score number (sorted ascending)
      // We want longest-waiting first, lowest ELO variance last
      const priorityScore = joinedAt; // Lower = been waiting longer

      // Also check TTL - remove if stale
      if (waitTimeMs > QUEUE_TTL_SECONDS * 1000) {
        await this.removeStaleAgent(agentId, gameMode);
        continue;
      }

      entries.push({
        agentId,
        eloRating: parseInt(meta.eloRating ?? '1200', 10),
        gameMode,
        joinedAt,
        priorityScore,
      });
    }

    return entries;
  }

  /**
   * Get an agent's position in their current queue.
   */
  async getQueuePosition(agentId: string, gameMode?: string): Promise<QueuePosition> {
    const resolvedGameMode = gameMode ?? (await this.getAgentGameMode(agentId));

    if (!resolvedGameMode) {
      return { position: -1, totalInQueue: 0, estimatedWaitMs: 0 };
    }

    const queueKey = QUEUE_KEY(resolvedGameMode);

    const [rank, total] = await Promise.all([
      this.redis.zrank(queueKey, agentId),
      this.redis.zcard(queueKey),
    ]);

    if (rank === null) {
      return { position: -1, totalInQueue: total, estimatedWaitMs: 0 };
    }

    const position = rank + 1; // 1-indexed
    // Estimate: ~30 seconds per match cycle, 1 match per 2 agents
    const estimatedWaitMs = Math.max(0, (position - 1)) * 30_000;

    return { position, totalInQueue: total, estimatedWaitMs };
  }

  /**
   * Check if an agent is currently in any queue.
   */
  async isInQueue(agentId: string): Promise<boolean> {
    const metaKey = AGENT_QUEUE_META_KEY(agentId);
    const exists = await this.redis.exists(metaKey);
    return exists > 0;
  }

  /**
   * Remove a stale agent from the queue (TTL exceeded).
   */
  async removeStaleAgent(agentId: string, gameMode: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.zrem(QUEUE_KEY(gameMode), agentId);
    pipeline.del(AGENT_QUEUE_META_KEY(agentId));
    await pipeline.exec();

    this.logger.info('Removed stale agent from queue', { agentId, gameMode });
  }

  /**
   * Remove multiple agents from a queue atomically (e.g., when a match is found).
   */
  async removeAgentsFromQueue(agentIds: string[], gameMode: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    const queueKey = QUEUE_KEY(gameMode);

    for (const agentId of agentIds) {
      pipeline.zrem(queueKey, agentId);
      pipeline.del(AGENT_QUEUE_META_KEY(agentId));
    }

    await pipeline.exec();
    this.logger.info('Removed matched agents from queue', { agentIds, gameMode });
  }

  /**
   * Get the queue size for a given game mode.
   */
  async getQueueSize(gameMode: string): Promise<number> {
    return this.redis.zcard(QUEUE_KEY(gameMode));
  }

  /**
   * Get all known game modes that have entries in queue.
   */
  async getActiveGameModes(): Promise<string[]> {
    const keys = await this.redis.keys('arena:queue:*');
    return keys.map((key) => key.replace('arena:queue:', ''));
  }

  private async getAgentGameMode(agentId: string): Promise<string | null> {
    const meta = await this.redis.hget(AGENT_QUEUE_META_KEY(agentId), 'gameMode');
    return meta;
  }
}
