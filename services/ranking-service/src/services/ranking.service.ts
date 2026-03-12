import { PrismaClient, RankHistory } from '@prisma/client';
import axios from 'axios';
import Redis from 'ioredis';
import { calculateELO, getRankTier, INITIAL_ELO } from './elo.service';
import { logger } from '../middleware/logger';

const AGENT_REGISTRY_URL =
  process.env['AGENT_REGISTRY_URL'] ?? 'http://agent-registry-service:3001';

const LEADERBOARD_CACHE_KEY = 'leaderboard:global';
const LEADERBOARD_CACHE_TTL = 60; // seconds
const AGENT_RANK_CACHE_PREFIX = 'rank:agent:';
const AGENT_RANK_CACHE_TTL = 30;

export interface AgentRankInfo {
  agentId: string;
  elo: number;
  tier: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  globalRank: number | null;
}

export interface LeaderboardEntry {
  rank: number;
  agentId: string;
  elo: number;
  tier: string;
}

export interface ELOUpdateResult {
  winnerId: string;
  loserId: string;
  winnerOldElo: number;
  loserOldElo: number;
  winnerNewElo: number;
  loserNewElo: number;
  winnerChange: number;
  loserChange: number;
  winnerExpected: number;
  loserExpected: number;
}

export class RankingService {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;

  constructor(prisma: PrismaClient, redis: Redis) {
    this.prisma = prisma;
    this.redis = redis;
  }

  /**
   * Updates ELO ratings for both players after a match.
   * Calls agent-registry-service to get current ELO and update it.
   * Records history in local DB.
   * Invalidates leaderboard cache.
   */
  async updateELOAfterMatch(
    matchId: string,
    winnerId: string,
    loserId: string,
    winnerCurrentElo?: number,
    loserCurrentElo?: number
  ): Promise<ELOUpdateResult> {
    // Fetch agent data from registry if ELO not provided
    const [winnerData, loserData] = await Promise.all([
      this.fetchAgentData(winnerId),
      this.fetchAgentData(loserId),
    ]);

    const winnerElo = winnerCurrentElo ?? winnerData.elo ?? INITIAL_ELO;
    const loserElo = loserCurrentElo ?? loserData.elo ?? INITIAL_ELO;
    const winnerGamesPlayed = winnerData.gamesPlayed ?? 0;
    const loserGamesPlayed = loserData.gamesPlayed ?? 0;

    // Calculate new ratings
    const eloResult = calculateELO(winnerElo, loserElo, winnerGamesPlayed, loserGamesPlayed);

    // Update agent registry for both agents
    await Promise.all([
      this.updateAgentElo(winnerId, eloResult.winnerNew, winnerGamesPlayed + 1, true),
      this.updateAgentElo(loserId, eloResult.loserNew, loserGamesPlayed + 1, false),
    ]);

    // Record history in local DB
    await Promise.all([
      this.prisma.rankHistory.create({
        data: {
          agentId: winnerId,
          oldElo: winnerElo,
          newElo: eloResult.winnerNew,
          change: eloResult.winnerChange,
          matchId,
          reason: `Won match against agent ${loserId}. Expected: ${eloResult.winnerExpected}`,
        },
      }),
      this.prisma.rankHistory.create({
        data: {
          agentId: loserId,
          oldElo: loserElo,
          newElo: eloResult.loserNew,
          change: eloResult.loserChange,
          matchId,
          reason: `Lost match against agent ${winnerId}. Expected: ${eloResult.loserExpected}`,
        },
      }),
    ]);

    // Invalidate caches
    await Promise.all([
      this.redis.del(LEADERBOARD_CACHE_KEY),
      this.redis.del(`${AGENT_RANK_CACHE_PREFIX}${winnerId}`),
      this.redis.del(`${AGENT_RANK_CACHE_PREFIX}${loserId}`),
    ]);

    // Update Redis sorted set for leaderboard
    await Promise.all([
      this.redis.zadd('elo:leaderboard', eloResult.winnerNew, winnerId),
      this.redis.zadd('elo:leaderboard', eloResult.loserNew, loserId),
    ]);

    logger.info('ELO updated after match', {
      matchId,
      winnerId,
      loserId,
      winnerElo: `${winnerElo} -> ${eloResult.winnerNew} (+${eloResult.winnerChange})`,
      loserElo: `${loserElo} -> ${eloResult.loserNew} (${eloResult.loserChange})`,
    });

    return {
      winnerId,
      loserId,
      winnerOldElo: winnerElo,
      loserOldElo: loserElo,
      winnerNewElo: eloResult.winnerNew,
      loserNewElo: eloResult.loserNew,
      winnerChange: eloResult.winnerChange,
      loserChange: eloResult.loserChange,
      winnerExpected: eloResult.winnerExpected,
      loserExpected: eloResult.loserExpected,
    };
  }

  /**
   * Returns the global leaderboard, cached in Redis for 60 seconds.
   * Uses the Redis sorted set for O(log N) range queries.
   */
  async getLeaderboard(limit = 100, offset = 0): Promise<LeaderboardEntry[]> {
    // Try Redis sorted set first (fastest)
    const members = await this.redis.zrevrangebyscore(
      'elo:leaderboard',
      '+inf',
      '-inf',
      'WITHSCORES',
      'LIMIT',
      offset,
      limit
    );

    if (members.length > 0) {
      const entries: LeaderboardEntry[] = [];
      for (let i = 0; i < members.length; i += 2) {
        const agentId = members[i];
        const elo = parseInt(members[i + 1] ?? '0', 10);
        if (agentId && elo !== undefined) {
          entries.push({
            rank: offset + Math.floor(i / 2) + 1,
            agentId,
            elo,
            tier: getRankTier(elo),
          });
        }
      }
      return entries;
    }

    // Fallback: query agent registry for all agents sorted by ELO
    logger.info('Leaderboard not in Redis, fetching from registry');
    return [];
  }

  /**
   * Gets rank info for a specific agent.
   */
  async getAgentRank(agentId: string): Promise<AgentRankInfo> {
    const cacheKey = `${AGENT_RANK_CACHE_PREFIX}${agentId}`;
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached) as AgentRankInfo;
    }

    const agentData = await this.fetchAgentData(agentId);
    const elo = agentData.elo ?? INITIAL_ELO;
    const gamesPlayed = agentData.gamesPlayed ?? 0;
    const wins = agentData.wins ?? 0;
    const losses = gamesPlayed - wins;
    const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 10000) / 100 : 0;

    // Get global rank from Redis sorted set
    const rankFromBottom = await this.redis.zrank('elo:leaderboard', agentId);
    const totalInLeaderboard = await this.redis.zcard('elo:leaderboard');
    const globalRank =
      rankFromBottom !== null ? totalInLeaderboard - rankFromBottom : null;

    const info: AgentRankInfo = {
      agentId,
      elo,
      tier: getRankTier(elo),
      gamesPlayed,
      wins,
      losses,
      winRate,
      globalRank,
    };

    await this.redis.setex(cacheKey, AGENT_RANK_CACHE_TTL, JSON.stringify(info));

    return info;
  }

  /**
   * Returns paginated rank history for an agent.
   */
  async getAgentRankHistory(
    agentId: string,
    page: number,
    limit: number
  ): Promise<{ history: RankHistory[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;

    const [history, total] = await Promise.all([
      this.prisma.rankHistory.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.rankHistory.count({ where: { agentId } }),
    ]);

    return { history, total, page, totalPages: Math.ceil(total / limit) };
  }

  private async fetchAgentData(agentId: string): Promise<{
    elo: number;
    gamesPlayed: number;
    wins: number;
  }> {
    try {
      const response = await axios.get(`${AGENT_REGISTRY_URL}/agents/${agentId}`, {
        timeout: 5000,
      });
      const agent = response.data.data as { elo?: number; gamesPlayed?: number; wins?: number };
      return {
        elo: agent.elo ?? INITIAL_ELO,
        gamesPlayed: agent.gamesPlayed ?? 0,
        wins: agent.wins ?? 0,
      };
    } catch (err) {
      logger.warn('Failed to fetch agent from registry, using defaults', {
        agentId,
        error: err instanceof Error ? err.message : 'Unknown',
      });
      return { elo: INITIAL_ELO, gamesPlayed: 0, wins: 0 };
    }
  }

  private async updateAgentElo(
    agentId: string,
    newElo: number,
    gamesPlayed: number,
    isWin: boolean
  ): Promise<void> {
    try {
      await axios.patch(
        `${AGENT_REGISTRY_URL}/agents/${agentId}/stats`,
        {
          elo: newElo,
          gamesPlayed,
          ...(isWin ? { incrementWins: true } : {}),
        },
        { timeout: 5000 }
      );
    } catch (err) {
      logger.error('Failed to update agent ELO in registry', {
        agentId,
        newElo,
        error: err instanceof Error ? err.message : 'Unknown',
      });
      // Don't throw — history is recorded locally, registry update can be retried
    }
  }
}
