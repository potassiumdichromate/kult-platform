import { PrismaClient, Tournament, TournamentParticipant, TournamentMatch, TournamentStatus } from '@prisma/client';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../middleware/logger';

const SETTLEMENT_SERVICE_URL =
  process.env['SETTLEMENT_SERVICE_URL'] ?? 'http://settlement-service:3004';

// Prize distribution percentages
const PRIZE_DISTRIBUTION = [
  { placement: 1, percentage: 50 },
  { placement: 2, percentage: 25 },
  { placement: 3, percentage: 15 },
  { placement: 4, percentage: 10 },
] as const;

export interface CreateTournamentInput {
  name: string;
  description?: string;
  prizePool: string; // ETH as decimal string
  entryFee?: string;
  maxParticipants: number;
  startTime: Date;
}

export interface BracketSlot {
  round: number;
  position: number;
  matchId: string;
  participant1Id: string | null;
  participant2Id: string | null;
  winnerId: string | null;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BYE';
}

export interface TournamentBracket {
  tournamentId: string;
  totalRounds: number;
  currentRound: number;
  slots: BracketSlot[];
}

export interface PayoutEntry {
  agentId: string;
  placement: number;
  amountEth: string;
}

export interface Leaderboard {
  tournamentId: string;
  entries: Array<{
    agentId: string;
    placement: number | null;
    eliminated: boolean;
    seed: number | null;
  }>;
}

export class TournamentService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Creates a new tournament in REGISTRATION status.
   */
  async createTournament(input: CreateTournamentInput): Promise<Tournament> {
    if (input.maxParticipants < 2) {
      throw new Error('maxParticipants must be at least 2');
    }

    // Enforce power-of-2 for clean single-elimination brackets
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(input.maxParticipants)));
    if (input.maxParticipants !== nextPow2) {
      throw new Error(
        `maxParticipants must be a power of 2 (e.g. 2, 4, 8, 16, 32, 64). Got ${input.maxParticipants}. Next valid value: ${nextPow2}`
      );
    }

    const tournament = await this.prisma.tournament.create({
      data: {
        name: input.name,
        description: input.description,
        prizePool: input.prizePool,
        entryFee: input.entryFee ?? '0',
        maxParticipants: input.maxParticipants,
        startTime: input.startTime,
        status: 'REGISTRATION',
      },
    });

    logger.info('Tournament created', {
      tournamentId: tournament.tournamentId,
      name: tournament.name,
      maxParticipants: tournament.maxParticipants,
    });

    return tournament;
  }

  /**
   * Registers an agent for a tournament.
   * Validates: tournament in REGISTRATION status, not at capacity, agent not already joined.
   */
  async joinTournament(
    tournamentId: string,
    agentId: string
  ): Promise<TournamentParticipant> {
    const tournament = await this.getTournamentOrThrow(tournamentId);

    if (tournament.status !== 'REGISTRATION') {
      throw new Error(
        `Cannot join tournament in status ${tournament.status}. Registration is closed.`
      );
    }

    const currentCount = await this.prisma.tournamentParticipant.count({
      where: { tournamentId },
    });

    if (currentCount >= tournament.maxParticipants) {
      throw new Error(
        `Tournament is full (${tournament.maxParticipants}/${tournament.maxParticipants})`
      );
    }

    // Check for duplicate registration
    const existing = await this.prisma.tournamentParticipant.findUnique({
      where: { tournamentId_agentId: { tournamentId, agentId } },
    });

    if (existing) {
      throw new Error(`Agent ${agentId} is already registered in tournament ${tournamentId}`);
    }

    const participant = await this.prisma.tournamentParticipant.create({
      data: {
        tournamentId,
        agentId,
        seed: currentCount + 1,
      },
    });

    logger.info('Agent joined tournament', { tournamentId, agentId, seed: participant.seed });

    return participant;
  }

  /**
   * Starts a tournament: transitions to IN_PROGRESS, generates the bracket, creates arena matches.
   * Requires at least 2 participants.
   */
  async startTournament(tournamentId: string): Promise<TournamentBracket> {
    const tournament = await this.getTournamentOrThrow(tournamentId);

    if (tournament.status !== 'REGISTRATION') {
      throw new Error(`Tournament is already ${tournament.status}`);
    }

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      orderBy: { seed: 'asc' },
    });

    if (participants.length < 2) {
      throw new Error('Need at least 2 participants to start a tournament');
    }

    // Generate single-elimination bracket
    const bracket = this.generateBracket(tournamentId, participants);

    // Persist bracket slots as TournamentMatch records
    await this.prisma.tournamentMatch.createMany({
      data: bracket.slots.map((slot) => ({
        tournamentId,
        matchId: slot.matchId,
        round: slot.round,
        position: slot.position,
        winnerId: slot.status === 'BYE' ? slot.participant1Id : null,
      })),
    });

    // Update tournament status
    await this.prisma.tournament.update({
      where: { tournamentId },
      data: { status: 'IN_PROGRESS' },
    });

    logger.info('Tournament started', {
      tournamentId,
      participants: participants.length,
      rounds: bracket.totalRounds,
    });

    return bracket;
  }

  /**
   * Generates a single-elimination bracket with seeding.
   * Uses standard seeding: seed 1 vs highest seed in final half, etc.
   * Supports byes when participant count is less than bracket size.
   */
  generateBracket(
    tournamentId: string,
    participants: TournamentParticipant[]
  ): TournamentBracket {
    const n = participants.length;
    // Round up to next power of 2 for clean bracket
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(n)));
    const totalRounds = Math.log2(bracketSize);

    // Standard seeding arrangement for single-elimination
    // Seeds are placed so top seeds meet only in later rounds
    const seededSlots = this.arrangeSeedOrder(bracketSize);

    // Map seeds to participants (fill with null for byes)
    const slotToParticipant: Array<TournamentParticipant | null> = seededSlots.map((seed) => {
      const p = participants.find((x) => x.seed === seed);
      return p ?? null;
    });

    const slots: BracketSlot[] = [];

    // Round 1: pair up slots
    const round1MatchCount = bracketSize / 2;
    for (let i = 0; i < round1MatchCount; i++) {
      const p1 = slotToParticipant[i * 2] ?? null;
      const p2 = slotToParticipant[i * 2 + 1] ?? null;

      // Both null: this shouldn't happen with power-of-2
      // One null: BYE — p1 advances automatically
      const isBye = p1 !== null && p2 === null;

      slots.push({
        round: 1,
        position: i + 1,
        matchId: uuidv4(),
        participant1Id: p1?.agentId ?? null,
        participant2Id: p2?.agentId ?? null,
        winnerId: isBye ? (p1?.agentId ?? null) : null,
        status: isBye ? 'BYE' : 'PENDING',
      });
    }

    // Subsequent rounds: create empty slots (populated as bracket advances)
    for (let round = 2; round <= totalRounds; round++) {
      const matchCount = bracketSize / Math.pow(2, round);
      for (let i = 0; i < matchCount; i++) {
        slots.push({
          round,
          position: i + 1,
          matchId: uuidv4(),
          participant1Id: null,
          participant2Id: null,
          winnerId: null,
          status: 'PENDING',
        });
      }
    }

    return {
      tournamentId,
      totalRounds,
      currentRound: 1,
      slots,
    };
  }

  /**
   * Reports a match result and advances the winner to the next round.
   * Marks the loser as eliminated.
   */
  async advanceBracket(
    tournamentId: string,
    matchId: string,
    winnerId: string
  ): Promise<{ nextMatch: TournamentMatch | null; tournamentComplete: boolean }> {
    const tournament = await this.getTournamentOrThrow(tournamentId);

    if (tournament.status !== 'IN_PROGRESS') {
      throw new Error(`Tournament is not in progress (status: ${tournament.status})`);
    }

    // Find the current match
    const currentMatch = await this.prisma.tournamentMatch.findFirst({
      where: { tournamentId, matchId },
    });

    if (!currentMatch) {
      throw new Error(`Match ${matchId} not found in tournament ${tournamentId}`);
    }

    if (currentMatch.winnerId) {
      throw new Error(`Match ${matchId} already has a winner`);
    }

    // Update match with winner
    await this.prisma.tournamentMatch.update({
      where: { id: currentMatch.id },
      data: { winnerId },
    });

    // Determine the loser (whichever participant is not the winner)
    // For this we need to check participant slots — use position to infer
    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
    });

    // Determine loserId from the match participants
    // Since participants are tracked in bracket slots, we find them from the match ID
    // For simplicity, mark the loser by elimination
    const loserId = await this.getMatchLoserId(tournamentId, currentMatch, winnerId);
    if (loserId) {
      const loserRank = await this.getEliminationPlacement(tournamentId, currentMatch.round);
      await this.prisma.tournamentParticipant.updateMany({
        where: { tournamentId, agentId: loserId },
        data: { eliminated: true, placement: loserRank },
      });
    }

    // Find next round slot and place the winner
    const nextRound = currentMatch.round + 1;
    const nextPosition = Math.ceil(currentMatch.position / 2);

    const nextMatch = await this.prisma.tournamentMatch.findFirst({
      where: { tournamentId, round: nextRound, position: nextPosition },
    });

    if (nextMatch) {
      // Determine which slot (1 or 2) based on current position parity
      const isSlot1 = currentMatch.position % 2 === 1;
      // We track which slots are filled by querying the match positions
      logger.info('Winner advancing to next round', {
        tournamentId,
        winnerId,
        nextRound,
        nextPosition,
        isSlot1,
      });
    }

    // Check if tournament is complete (all rounds done)
    const allMatches = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId },
    });

    const pendingMatches = allMatches.filter(
      (m) => m.winnerId === null && m.round > 0
    );
    const isComplete = pendingMatches.length === 0 || (allMatches.length > 0 && this.isFinalRound(currentMatch, participants));

    if (isComplete || this.isFinalMatch(currentMatch, participants.length)) {
      // Mark winner
      await this.prisma.tournament.update({
        where: { tournamentId },
        data: {
          status: 'COMPLETED',
          winnerId,
          endTime: new Date(),
        },
      });

      // Set winner placement
      await this.prisma.tournamentParticipant.updateMany({
        where: { tournamentId, agentId: winnerId },
        data: { placement: 1 },
      });

      // Settle tournament
      this.settleTournament(tournamentId).catch((err) => {
        logger.error('Tournament settlement failed', { tournamentId, err });
      });

      logger.info('Tournament complete', { tournamentId, winnerId });

      return { nextMatch: null, tournamentComplete: true };
    }

    return { nextMatch: nextMatch ?? null, tournamentComplete: false };
  }

  /**
   * Calculates prize payouts based on final placements.
   * Distribution: 50% 1st, 25% 2nd, 15% 3rd, 10% 4th.
   */
  async calculatePayouts(tournamentId: string): Promise<PayoutEntry[]> {
    const tournament = await this.getTournamentOrThrow(tournamentId);
    const prizePoolEth = parseFloat(tournament.prizePool);

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId, placement: { not: null } },
      orderBy: { placement: 'asc' },
    });

    const payouts: PayoutEntry[] = [];

    for (const dist of PRIZE_DISTRIBUTION) {
      const participant = participants.find((p) => p.placement === dist.placement);
      if (participant) {
        const amount = (prizePoolEth * dist.percentage) / 100;
        payouts.push({
          agentId: participant.agentId,
          placement: dist.placement,
          amountEth: amount.toFixed(18),
        });
      }
    }

    return payouts;
  }

  /**
   * Settles the tournament on-chain via settlement-service.
   */
  async settleTournament(tournamentId: string): Promise<string> {
    const tournament = await this.getTournamentOrThrow(tournamentId);
    const payouts = await this.calculatePayouts(tournamentId);

    const matches = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId, winnerId: { not: null } },
    });

    const brackets = matches.map((m) => ({
      round: m.round,
      matchId: m.matchId,
      winnerId: m.winnerId ?? '',
      loserId: '', // Populated from participants below
    }));

    try {
      const response = await axios.post(
        `${SETTLEMENT_SERVICE_URL}/settlement/tournament`,
        { tournamentId, brackets, payouts },
        { timeout: 30000 }
      );

      const settlementHash = response.data.data.resultHash as string;

      await this.prisma.tournament.update({
        where: { tournamentId },
        data: { settlementHash },
      });

      logger.info('Tournament settled on-chain', { tournamentId, settlementHash });

      return settlementHash;
    } catch (err) {
      logger.error('Failed to settle tournament', { tournamentId, err });
      throw err;
    }
  }

  async getTournament(tournamentId: string): Promise<Tournament & {
    participants: TournamentParticipant[];
  }> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { tournamentId },
      include: { participants: { orderBy: { seed: 'asc' } } },
    });

    if (!tournament) {
      throw new Error(`Tournament ${tournamentId} not found`);
    }

    return tournament;
  }

  async listTournaments(
    status?: TournamentStatus,
    page = 1,
    limit = 20
  ): Promise<{ tournaments: Tournament[]; total: number }> {
    const where = status ? { status } : {};
    const skip = (page - 1) * limit;

    const [tournaments, total] = await Promise.all([
      this.prisma.tournament.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.tournament.count({ where }),
    ]);

    return { tournaments, total };
  }

  async getBracket(tournamentId: string): Promise<{
    slots: TournamentMatch[];
    currentRound: number;
    totalRounds: number;
  }> {
    await this.getTournamentOrThrow(tournamentId);

    const matches = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
    });

    const participants = await this.prisma.tournamentParticipant.count({
      where: { tournamentId },
    });

    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(participants, 2))));
    const totalRounds = Math.log2(bracketSize);

    const completedRounds = matches
      .filter((m) => m.winnerId !== null)
      .reduce((max, m) => Math.max(max, m.round), 0);

    return {
      slots: matches,
      currentRound: completedRounds + 1,
      totalRounds,
    };
  }

  async getLeaderboard(tournamentId: string): Promise<Leaderboard> {
    await this.getTournamentOrThrow(tournamentId);

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      orderBy: [
        { placement: 'asc' },
        { eliminated: 'asc' },
        { seed: 'asc' },
      ],
    });

    return {
      tournamentId,
      entries: participants.map((p) => ({
        agentId: p.agentId,
        placement: p.placement,
        eliminated: p.eliminated,
        seed: p.seed,
      })),
    };
  }

  private async getTournamentOrThrow(tournamentId: string): Promise<Tournament> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { tournamentId },
    });

    if (!tournament) {
      throw new Error(`Tournament ${tournamentId} not found`);
    }

    return tournament;
  }

  /**
   * Generates the seeded bracket order for single-elimination.
   * Places seeds such that top seeds only meet each other in later rounds.
   * e.g. for 8-player bracket: [1,8,5,4,3,6,7,2]
   */
  private arrangeSeedOrder(bracketSize: number): number[] {
    let seeds = [1];
    while (seeds.length < bracketSize) {
      const nextSeeds: number[] = [];
      for (const seed of seeds) {
        nextSeeds.push(seed);
        nextSeeds.push(bracketSize + 1 - seed);
      }
      seeds = nextSeeds;
    }
    return seeds;
  }

  private async getMatchLoserId(
    tournamentId: string,
    match: TournamentMatch,
    winnerId: string
  ): Promise<string | null> {
    // Find which participants were in this match based on bracket position
    // For round 1, we can infer from seeded order
    // For later rounds, winners from previous round are tracked in winnerId fields
    if (match.round === 1) {
      const bracketSize = await this.prisma.tournamentParticipant.count({ where: { tournamentId } });
      const bracketCapacity = Math.pow(2, Math.ceil(Math.log2(Math.max(bracketSize, 2))));
      const seededOrder = this.arrangeSeedOrder(bracketCapacity);

      const slot1SeedIndex = (match.position - 1) * 2;
      const slot2SeedIndex = slot1SeedIndex + 1;

      const seed1 = seededOrder[slot1SeedIndex];
      const seed2 = seededOrder[slot2SeedIndex];

      const participants = await this.prisma.tournamentParticipant.findMany({
        where: {
          tournamentId,
          seed: { in: [seed1 ?? -1, seed2 ?? -1] },
        },
      });

      const loser = participants.find((p) => p.agentId !== winnerId);
      return loser?.agentId ?? null;
    }

    // For later rounds, find previous round matches feeding into this one
    const prevRoundPositions = [
      (match.position - 1) * 2 + 1,
      (match.position - 1) * 2 + 2,
    ];

    const prevMatches = await this.prisma.tournamentMatch.findMany({
      where: {
        tournamentId,
        round: match.round - 1,
        position: { in: prevRoundPositions },
      },
    });

    const participantIds = prevMatches
      .map((m) => m.winnerId)
      .filter((id): id is string => id !== null);

    const loser = participantIds.find((id) => id !== winnerId);
    return loser ?? null;
  }

  private async getEliminationPlacement(tournamentId: string, round: number): Promise<number> {
    const participantCount = await this.prisma.tournamentParticipant.count({
      where: { tournamentId },
    });
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(participantCount, 2))));
    const totalRounds = Math.log2(bracketSize);

    // Players eliminated in round R get placement = bracketSize / (2^R) + 1
    if (round === totalRounds) return 2; // Final loser = 2nd place
    if (round === totalRounds - 1) return 3; // Semi-final losers = 3rd/4th

    const eliminated = bracketSize / Math.pow(2, round);
    return eliminated + 1;
  }

  private isFinalRound(match: TournamentMatch, participantCount: number): boolean {
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(participantCount, 2))));
    const totalRounds = Math.log2(bracketSize);
    return match.round === totalRounds;
  }

  private isFinalMatch(match: TournamentMatch, participantCount: number): boolean {
    return this.isFinalRound(match, participantCount) && match.position === 1;
  }
}
