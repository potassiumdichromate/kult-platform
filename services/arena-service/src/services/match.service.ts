import { PrismaClient, Match, MatchStatus } from '@prisma/client';
import axios from 'axios';
import { Logger } from 'winston';

// ─── Service URLs ─────────────────────────────────────────────────────────────

const RANKING_SERVICE_URL =
  process.env.RANKING_SERVICE_URL ?? 'http://ranking-service:3005';
const SETTLEMENT_SERVICE_URL =
  process.env.SETTLEMENT_SERVICE_URL ?? 'http://settlement-service:3006';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateMatchOptions {
  agent1Id: string;
  agent2Id: string;
  gameMode?: string;
  mapId?: string;
  tournamentId?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitResultData {
  winnerId: string;
  resultHash: string;
  telemetry?: Record<string, unknown>;
}

export interface PaginatedMatches {
  matches: Match[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface EloUpdateResponse {
  agent1NewElo: number;
  agent2NewElo: number;
  eloChange1: number;
  eloChange2: number;
}

// ─── Match Service ────────────────────────────────────────────────────────────

export class MatchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger
  ) {}

  /**
   * Create a new match record. Sets status to PENDING, transition to ACTIVE is
   * handled externally when the actual game session is established.
   */
  async createMatch(options: CreateMatchOptions): Promise<Match> {
    if (options.agent1Id === options.agent2Id) {
      throw new Error('An agent cannot be matched against itself');
    }

    const match = await this.prisma.match.create({
      data: {
        agent1Id: options.agent1Id,
        agent2Id: options.agent2Id,
        gameMode: options.gameMode ?? 'deathmatch',
        mapId: options.mapId,
        tournamentId: options.tournamentId,
        status: MatchStatus.PENDING,
        metadata: options.metadata ?? {},
      },
    });

    this.logger.info('Match created', {
      matchId: match.matchId,
      agent1Id: match.agent1Id,
      agent2Id: match.agent2Id,
      gameMode: match.gameMode,
    });

    return match;
  }

  /**
   * Get a match by its ID.
   */
  async getMatchById(matchId: string): Promise<Match | null> {
    return this.prisma.match.findUnique({ where: { matchId } });
  }

  /**
   * Submit the result of a match.
   * Steps:
   * 1. Validate the match is in ACTIVE or PENDING status
   * 2. Validate the winnerId is one of the participants
   * 3. Update match record to COMPLETED
   * 4. Call ranking-service for ELO recalculation
   * 5. Call settlement-service for reward distribution
   */
  async submitResult(
    matchId: string,
    data: SubmitResultData
  ): Promise<Match> {
    const match = await this.prisma.match.findUnique({ where: { matchId } });

    if (!match) {
      throw new Error(`Match ${matchId} not found`);
    }

    if (match.status === MatchStatus.COMPLETED) {
      throw new Error(`Match ${matchId} is already completed`);
    }

    if (match.status === MatchStatus.CANCELLED) {
      throw new Error(`Match ${matchId} has been cancelled and cannot receive a result`);
    }

    // Validate winner is a participant
    if (data.winnerId !== match.agent1Id && data.winnerId !== match.agent2Id) {
      throw new Error(
        `Winner ${data.winnerId} is not a participant in match ${matchId}. ` +
          `Participants: ${match.agent1Id}, ${match.agent2Id}`
      );
    }

    // Call ranking service for ELO update
    let eloChanges: EloUpdateResponse = {
      agent1NewElo: 1200,
      agent2NewElo: 1200,
      eloChange1: 0,
      eloChange2: 0,
    };

    try {
      eloChanges = await this.callRankingService({
        agent1Id: match.agent1Id,
        agent2Id: match.agent2Id,
        winnerId: data.winnerId,
        matchId,
      });
    } catch (err) {
      this.logger.error('Failed to update ELO via ranking service', {
        matchId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      // Non-blocking: match result is still recorded even if ELO update fails
    }

    // Update the match record
    const updatedMatch = await this.prisma.match.update({
      where: { matchId },
      data: {
        status: MatchStatus.COMPLETED,
        winnerId: data.winnerId,
        resultHash: data.resultHash,
        eloChange1: eloChanges.eloChange1,
        eloChange2: eloChanges.eloChange2,
        endedAt: new Date(),
        metadata: {
          ...(typeof match.metadata === 'object' && match.metadata !== null
            ? (match.metadata as Record<string, unknown>)
            : {}),
          telemetry: data.telemetry ?? {},
          eloUpdate: eloChanges,
        },
      },
    });

    this.logger.info('Match result submitted', {
      matchId,
      winnerId: data.winnerId,
      eloChange1: eloChanges.eloChange1,
      eloChange2: eloChanges.eloChange2,
    });

    // Notify settlement service asynchronously (don't block)
    this.callSettlementService({
      matchId,
      winnerId: data.winnerId,
      agent1Id: match.agent1Id,
      agent2Id: match.agent2Id,
      resultHash: data.resultHash,
    }).catch((err) => {
      this.logger.error('Failed to notify settlement service', {
        matchId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    });

    return updatedMatch;
  }

  /**
   * Get paginated match history for an agent.
   */
  async getMatchHistory(
    agentId: string,
    page: number,
    limit: number,
    status?: MatchStatus
  ): Promise<PaginatedMatches> {
    const offset = (page - 1) * limit;

    const where = {
      OR: [{ agent1Id: agentId }, { agent2Id: agentId }],
      ...(status !== undefined ? { status } : {}),
    };

    const [matches, total] = await this.prisma.$transaction([
      this.prisma.match.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.match.count({ where }),
    ]);

    return {
      matches,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get all currently active matches.
   */
  async getActiveMatches(): Promise<Match[]> {
    return this.prisma.match.findMany({
      where: { status: MatchStatus.ACTIVE },
      orderBy: { startedAt: 'asc' },
    });
  }

  /**
   * Cancel a match. Only PENDING or ACTIVE matches can be cancelled.
   */
  async cancelMatch(matchId: string, reason?: string): Promise<Match> {
    const match = await this.prisma.match.findUnique({ where: { matchId } });

    if (!match) {
      throw new Error(`Match ${matchId} not found`);
    }

    if (match.status === MatchStatus.COMPLETED) {
      throw new Error(`Match ${matchId} is already completed and cannot be cancelled`);
    }

    if (match.status === MatchStatus.CANCELLED) {
      return match; // Idempotent
    }

    const updated = await this.prisma.match.update({
      where: { matchId },
      data: {
        status: MatchStatus.CANCELLED,
        endedAt: new Date(),
        metadata: {
          ...(typeof match.metadata === 'object' && match.metadata !== null
            ? (match.metadata as Record<string, unknown>)
            : {}),
          cancelReason: reason ?? 'Manual cancellation',
          cancelledAt: new Date().toISOString(),
        },
      },
    });

    this.logger.info('Match cancelled', { matchId, reason });
    return updated;
  }

  /**
   * Transition a match from PENDING to ACTIVE.
   */
  async activateMatch(matchId: string): Promise<Match> {
    return this.prisma.match.update({
      where: { matchId },
      data: {
        status: MatchStatus.ACTIVE,
        startedAt: new Date(),
      },
    });
  }

  // ─── Internal service calls ─────────────────────────────────────────────────

  private async callRankingService(data: {
    agent1Id: string;
    agent2Id: string;
    winnerId: string;
    matchId: string;
  }): Promise<EloUpdateResponse> {
    const client = axios.create({
      baseURL: RANKING_SERVICE_URL,
      timeout: 8_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Name': 'arena-service',
        ...(process.env.INTERNAL_API_KEY
          ? { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY }
          : {}),
      },
    });

    const response = await client.post<EloUpdateResponse>('/ranking/elo/update', data);
    return response.data;
  }

  private async callSettlementService(data: {
    matchId: string;
    winnerId: string;
    agent1Id: string;
    agent2Id: string;
    resultHash: string;
  }): Promise<void> {
    const client = axios.create({
      baseURL: SETTLEMENT_SERVICE_URL,
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Name': 'arena-service',
        ...(process.env.INTERNAL_API_KEY
          ? { 'X-Internal-Api-Key': process.env.INTERNAL_API_KEY }
          : {}),
      },
    });

    await client.post('/settlement/match', data);
    this.logger.info('Settlement notified', { matchId: data.matchId });
  }
}
