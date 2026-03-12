// =============================================================================
// KULT Platform — Shared TypeScript Types & Interfaces
// =============================================================================

// ---------------------------------------------------------------------------
// AGENT
// ---------------------------------------------------------------------------

export enum AgentStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  SUSPENDED = 'SUSPENDED',
  TRAINING = 'TRAINING',
}

export interface Agent {
  agentId: string;
  ownerWallet: string;
  hotWalletAddress: string;
  modelHash: string;
  eloRating: number;
  reputationScore: number;
  status: AgentStatus;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgentDTO {
  ownerWallet: string;
  modelHash: string;
  name: string;
  description?: string;
}

export interface UpdateAgentDTO {
  modelHash?: string;
  name?: string;
  description?: string;
  status?: AgentStatus;
}

// ---------------------------------------------------------------------------
// MODEL
// ---------------------------------------------------------------------------

export interface Model {
  modelId: string;
  agentId: string;
  storageHash: string;
  version: number;
  trainingDatasetSize: number;
  accuracy: number;
  parameters: number;
  frameworkVersion: string;
  createdAt: Date;
}

export interface CreateModelDTO {
  agentId: string;
  storageHash: string;
  trainingDatasetSize: number;
  accuracy: number;
  parameters: number;
  frameworkVersion: string;
}

// ---------------------------------------------------------------------------
// MATCH
// ---------------------------------------------------------------------------

export enum MatchStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface Match {
  matchId: string;
  player1AgentId: string;
  player2AgentId: string;
  status: MatchStatus;
  winnerId?: string;
  startedAt?: Date;
  endedAt?: Date;
  eloChange1: number;
  eloChange2: number;
  tournamentId?: string;
  mapSeed: string;
  replayStorageHash?: string;
}

export interface MatchResult {
  matchId: string;
  winnerId: string | null;
  isDraw: boolean;
  durationMs: number;
  replayStorageHash?: string;
}

// ---------------------------------------------------------------------------
// TOURNAMENT
// ---------------------------------------------------------------------------

export enum TournamentStatus {
  REGISTRATION = 'REGISTRATION',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface TournamentBracket {
  round: number;
  matches: Match[];
}

export interface Tournament {
  tournamentId: string;
  name: string;
  description: string;
  status: TournamentStatus;
  prizePool: string;
  prizeTokenAddress: string;
  maxParticipants: number;
  registeredParticipants: string[];
  startTime: Date;
  endTime?: Date;
  brackets: TournamentBracket[];
  winnerId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTournamentDTO {
  name: string;
  description: string;
  prizePool: string;
  prizeTokenAddress: string;
  maxParticipants: number;
  startTime: Date;
}

// ---------------------------------------------------------------------------
// AI TRANSACTIONS & POLICY
// ---------------------------------------------------------------------------

export enum TransactionType {
  BUY_WEAPON = 'BUY_WEAPON',
  UPGRADE_WEAPON = 'UPGRADE_WEAPON',
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
}

export enum TxStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUBMITTED = 'SUBMITTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export interface PolicyResult {
  approved: boolean;
  reason: string;
  spendingLimitOk: boolean;
  contractWhitelisted: boolean;
  amountWithinLimit: boolean;
}

export interface AITransaction {
  txId: string;
  agentId: string;
  type: TransactionType;
  amount: string;
  targetContract: string;
  calldata: string;
  status: TxStatus;
  txHash?: string;
  policyResult: PolicyResult;
  gasEstimate?: string;
  nonce?: number;
  submittedAt?: Date;
  confirmedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AITransactionRequest {
  agentId: string;
  type: TransactionType;
  amount: string;
  targetContract: string;
  calldata: string;
}

// ---------------------------------------------------------------------------
// WALLET
// ---------------------------------------------------------------------------

export interface WalletInfo {
  address: string;
  agentId: string;
  balance: string;
  nonce: number;
  chainId: number;
}

export interface EncryptedWallet {
  agentId: string;
  address: string;
  encryptedPrivateKey: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// TELEMETRY
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  eventId: string;
  agentId: string;
  matchId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: Date;
  sequenceNumber: number;
}

export interface TelemetryEventBatch {
  events: Array<Omit<TelemetryEvent, 'eventId' | 'timestamp'>>;
}

// ---------------------------------------------------------------------------
// ELO / RANKING
// ---------------------------------------------------------------------------

export interface ELOResult {
  newRating1: number;
  newRating2: number;
  change1: number;
  change2: number;
}

export interface RankingEntry {
  rank: number;
  agentId: string;
  ownerWallet: string;
  name: string;
  eloRating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
}

export interface ELOHistoryEntry {
  agentId: string;
  matchId: string;
  ratingBefore: number;
  ratingAfter: number;
  change: number;
  opponentId: string;
  opponentRating: number;
  outcome: 'WIN' | 'LOSS' | 'DRAW';
  recordedAt: Date;
}

// ---------------------------------------------------------------------------
// MATCHMAKING
// ---------------------------------------------------------------------------

export interface MatchmakingQueue {
  agentId: string;
  eloRating: number;
  queuedAt: number;
}

export interface MatchmakingResult {
  matched: boolean;
  matchId?: string;
  opponentAgentId?: string;
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

export interface JWTPayload {
  sub: string;
  wallet: string;
  agentId?: string;
  iat: number;
  exp: number;
}

export interface NonceResponse {
  nonce: string;
  message: string;
  expiresAt: number;
}

export interface AuthVerifyRequest {
  wallet: string;
  nonce: string;
  signature: string;
}

export interface AuthVerifyResponse {
  token: string;
  expiresIn: string;
  wallet: string;
}

// ---------------------------------------------------------------------------
// API RESPONSE ENVELOPE
// ---------------------------------------------------------------------------

export interface APIResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  requestId?: string;
  timestamp?: string;
}

export interface PaginatedResponse<T> extends APIResponse<T[]> {
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// ---------------------------------------------------------------------------
// PAGINATION / QUERY HELPERS
// ---------------------------------------------------------------------------

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// INTERNAL SERVICE EVENTS (used via Redis pub/sub or direct HTTP)
// ---------------------------------------------------------------------------

export interface MatchCompletedEvent {
  matchId: string;
  winnerId: string | null;
  player1AgentId: string;
  player2AgentId: string;
  eloChange1: number;
  eloChange2: number;
  tournamentId?: string;
  completedAt: string;
}

export interface AgentRegisteredEvent {
  agentId: string;
  ownerWallet: string;
  hotWalletAddress: string;
  chainTxHash: string;
  registeredAt: string;
}

export interface TransactionConfirmedEvent {
  txId: string;
  agentId: string;
  txHash: string;
  confirmedAt: string;
}
