import { PrismaClient, Settlement } from '@prisma/client';
import { ethers } from 'ethers';
import { logger } from '../middleware/logger';

// Settlement contract ABI (minimal interface)
const SETTLEMENT_CONTRACT_ABI = [
  'function settleMatch(bytes32 matchId, bytes32 resultHash, address winner) external returns (bytes32)',
  'function settleTournament(bytes32 tournamentId, bytes32 merkleRoot) external returns (bytes32)',
  'function getSettlement(bytes32 settlementId) external view returns (bytes32 resultHash, bool verified, uint256 blockNumber)',
  'event MatchSettled(bytes32 indexed settlementId, bytes32 indexed matchId, bytes32 resultHash)',
  'event TournamentSettled(bytes32 indexed settlementId, bytes32 indexed tournamentId, bytes32 merkleRoot)',
];

export interface MatchData {
  matchId: string;
  winnerId: string;
  loserId: string;
  rounds: number;
  winnerKills: number;
  loserKills: number;
  duration: number;
  timestamp: number;
}

export interface TournamentBracket {
  round: number;
  matchId: string;
  winnerId: string;
  loserId: string;
}

export interface TournamentPayout {
  agentId: string;
  placement: number;
  amountEth: string;
}

export interface SettlementResult {
  settlementId: string;
  txHash?: string;
  resultHash: string;
  status: string;
}

export class SettlementService {
  private readonly prisma: PrismaClient;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly settlementContract: ethers.Contract | null;
  private readonly signer: ethers.Wallet | null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;

    const rpcUrl = process.env['BLOCKCHAIN_RPC_URL'];
    if (!rpcUrl) {
      throw new Error('BLOCKCHAIN_RPC_URL environment variable is required');
    }

    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    // Settlement contract signer (service-level key for submitting settlements)
    const settlerPrivateKey = process.env['SETTLER_PRIVATE_KEY'];
    const contractAddress = process.env['SETTLEMENT_CONTRACT'];

    if (settlerPrivateKey && contractAddress) {
      this.signer = new ethers.Wallet(settlerPrivateKey, this.provider);
      this.settlementContract = new ethers.Contract(
        contractAddress,
        SETTLEMENT_CONTRACT_ABI,
        this.signer
      );
    } else {
      logger.warn('SETTLER_PRIVATE_KEY or SETTLEMENT_CONTRACT not set — on-chain settlement disabled');
      this.signer = null;
      this.settlementContract = null;
    }
  }

  /**
   * Settles a match result on-chain.
   * Computes a keccak256 hash of the match result, submits to settlement contract.
   */
  async settleMatch(matchId: string, winnerId: string, matchData: MatchData): Promise<SettlementResult> {
    const resultHash = this.generateResultHash(matchData);

    // Create pending settlement record
    const settlement = await this.prisma.settlement.create({
      data: {
        matchId,
        type: 'MATCH',
        resultHash,
        status: 'PENDING',
      },
    });

    if (!this.settlementContract || !this.signer) {
      // Off-chain mode: just record the hash
      logger.info('Settlement recorded (off-chain mode)', {
        settlementId: settlement.settlementId,
        matchId,
        resultHash,
      });

      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: { status: 'CONFIRMED_OFFCHAIN', verifiedAt: new Date() },
      });

      return {
        settlementId: settlement.settlementId,
        resultHash,
        status: 'CONFIRMED_OFFCHAIN',
      };
    }

    try {
      // Convert IDs to bytes32
      const matchIdBytes32 = this.toBytes32(matchId);
      const resultHashBytes32 = resultHash as `0x${string}`;
      const winnerAddress = this.idToAddress(winnerId);

      // Submit to blockchain
      const tx = await this.settlementContract['settleMatch'](
        matchIdBytes32,
        resultHashBytes32,
        winnerAddress
      ) as ethers.TransactionResponse;

      logger.info('Match settlement tx submitted', {
        settlementId: settlement.settlementId,
        txHash: tx.hash,
        matchId,
      });

      // Wait for 1 confirmation
      const receipt = await tx.wait(1);

      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: {
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber ? BigInt(receipt.blockNumber) : null,
          status: receipt?.status === 1 ? 'CONFIRMED' : 'FAILED',
          verifiedAt: receipt?.status === 1 ? new Date() : null,
        },
      });

      return {
        settlementId: settlement.settlementId,
        txHash: tx.hash,
        resultHash,
        status: receipt?.status === 1 ? 'CONFIRMED' : 'FAILED',
      };
    } catch (err) {
      logger.error('Match settlement failed', {
        settlementId: settlement.settlementId,
        matchId,
        err,
      });

      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: { status: 'FAILED' },
      });

      throw new Error(`Settlement failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  /**
   * Settles a tournament result using a Merkle root of all participant results and payouts.
   */
  async settleTournament(
    tournamentId: string,
    brackets: TournamentBracket[],
    payouts: TournamentPayout[]
  ): Promise<SettlementResult> {
    // Generate Merkle root from bracket data
    const merkleRoot = this.generateMerkleRoot(brackets, payouts);

    const settlement = await this.prisma.settlement.create({
      data: {
        tournamentId,
        type: 'TOURNAMENT',
        resultHash: merkleRoot,
        proof: JSON.stringify({ brackets, payouts }),
        status: 'PENDING',
      },
    });

    if (!this.settlementContract || !this.signer) {
      logger.info('Tournament settlement recorded (off-chain mode)', {
        settlementId: settlement.settlementId,
        tournamentId,
        merkleRoot,
      });

      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: { status: 'CONFIRMED_OFFCHAIN', verifiedAt: new Date() },
      });

      return {
        settlementId: settlement.settlementId,
        resultHash: merkleRoot,
        status: 'CONFIRMED_OFFCHAIN',
      };
    }

    try {
      const tournamentIdBytes32 = this.toBytes32(tournamentId);
      const merkleRootBytes32 = merkleRoot as `0x${string}`;

      const tx = await this.settlementContract['settleTournament'](
        tournamentIdBytes32,
        merkleRootBytes32
      ) as ethers.TransactionResponse;

      const receipt = await tx.wait(1);

      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: {
          txHash: tx.hash,
          blockNumber: receipt?.blockNumber ? BigInt(receipt.blockNumber) : null,
          status: receipt?.status === 1 ? 'CONFIRMED' : 'FAILED',
          verifiedAt: receipt?.status === 1 ? new Date() : null,
        },
      });

      logger.info('Tournament settlement confirmed', {
        settlementId: settlement.settlementId,
        tournamentId,
        txHash: tx.hash,
      });

      return {
        settlementId: settlement.settlementId,
        txHash: tx.hash,
        resultHash: merkleRoot,
        status: receipt?.status === 1 ? 'CONFIRMED' : 'FAILED',
      };
    } catch (err) {
      await this.prisma.settlement.update({
        where: { settlementId: settlement.settlementId },
        data: { status: 'FAILED' },
      });
      throw new Error(`Tournament settlement failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  /**
   * Reads settlement state from the blockchain to verify on-chain confirmation.
   */
  async verifySettlement(settlementId: string): Promise<Settlement> {
    const settlement = await this.prisma.settlement.findUnique({
      where: { settlementId },
    });

    if (!settlement) {
      throw new Error(`Settlement ${settlementId} not found`);
    }

    if (!this.settlementContract || !settlement.txHash) {
      return settlement;
    }

    try {
      // Check on-chain state
      const onChainData = await this.settlementContract['getSettlement'](
        settlement.resultHash as `0x${string}`
      ) as [string, boolean, bigint];

      const [_onChainHash, isVerified, blockNumber] = onChainData;

      if (isVerified && settlement.status !== 'CONFIRMED') {
        const updated = await this.prisma.settlement.update({
          where: { settlementId },
          data: {
            status: 'CONFIRMED',
            blockNumber,
            verifiedAt: new Date(),
          },
        });
        return updated;
      }
    } catch (err) {
      logger.warn('Failed to verify on-chain', { settlementId, err });
    }

    return settlement;
  }

  async getSettlement(settlementId: string): Promise<Settlement | null> {
    return this.prisma.settlement.findUnique({ where: { settlementId } });
  }

  /**
   * Generates a keccak256 hash of the match result data.
   * The hash commits to all relevant match fields for integrity verification.
   */
  generateResultHash(matchData: MatchData): string {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'string', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      [
        matchData.matchId,
        matchData.winnerId,
        matchData.loserId,
        matchData.rounds,
        matchData.winnerKills,
        matchData.loserKills,
        matchData.duration,
        matchData.timestamp,
      ]
    );
    return ethers.keccak256(encoded);
  }

  /**
   * Generates a Merkle root from tournament bracket and payout data.
   * Each leaf is a hash of (matchId, winnerId, agentId, placement, amountEth).
   */
  private generateMerkleRoot(brackets: TournamentBracket[], payouts: TournamentPayout[]): string {
    const leaves: string[] = [];

    // Hash each bracket match
    for (const bracket of brackets) {
      const leaf = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['string', 'string', 'string', 'uint256'],
          [bracket.matchId, bracket.winnerId, bracket.loserId, bracket.round]
        )
      );
      leaves.push(leaf);
    }

    // Hash each payout
    for (const payout of payouts) {
      const leaf = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['string', 'uint256', 'string'],
          [payout.agentId, payout.placement, payout.amountEth]
        )
      );
      leaves.push(leaf);
    }

    if (leaves.length === 0) {
      return ethers.ZeroHash;
    }

    // Build Merkle tree
    return this.buildMerkleRoot(leaves);
  }

  private buildMerkleRoot(leaves: string[]): string {
    if (leaves.length === 1) {
      return leaves[0] as string;
    }

    const nextLevel: string[] = [];
    for (let i = 0; i < leaves.length; i += 2) {
      const left = leaves[i] as string;
      const right = i + 1 < leaves.length ? leaves[i + 1] as string : left;

      // Sort leaves before hashing for canonical tree structure
      const [a, b] = left < right ? [left, right] : [right, left];
      const combined = ethers.keccak256(
        ethers.concat([ethers.getBytes(a), ethers.getBytes(b)])
      );
      nextLevel.push(combined);
    }

    return this.buildMerkleRoot(nextLevel);
  }

  private toBytes32(value: string): string {
    // Convert UUID/ID to bytes32 by hashing it
    return ethers.keccak256(ethers.toUtf8Bytes(value));
  }

  private idToAddress(agentId: string): string {
    // In a real system this would look up the agent's wallet address
    // For now we derive a deterministic address from the ID
    const hash = ethers.keccak256(ethers.toUtf8Bytes(agentId));
    return ethers.getAddress('0x' + hash.slice(26));
  }
}
