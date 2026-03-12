import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { TransactionService } from '../services/transaction.service';
import { logger } from '../middleware/logger';

const TX_QUEUE_NAME = 'ai-transactions';

interface TransactionJobData {
  txId: string;
}

/**
 * BullMQ worker that processes approved AI transactions.
 *
 * Responsibilities:
 *   1. Calls wallet-service to sign the transaction
 *   2. Broadcasts signed transaction to blockchain
 *   3. Polls for confirmation (with retry on failure)
 *   4. Updates transaction status on each state change
 */
export function createTransactionWorker(
  prisma: PrismaClient,
  redis: Redis
): Worker<TransactionJobData> {
  const transactionService = new TransactionService(prisma, redis);

  const worker = new Worker<TransactionJobData>(
    TX_QUEUE_NAME,
    async (job: Job<TransactionJobData>) => {
      const { txId } = job.data;

      logger.info('Processing transaction job', {
        jobId: job.id,
        txId,
        attempt: job.attemptsMade + 1,
      });

      try {
        await transactionService.executeTransaction(txId);

        logger.info('Transaction job completed successfully', {
          jobId: job.id,
          txId,
        });
      } catch (err) {
        logger.error('Transaction job failed', {
          jobId: job.id,
          txId,
          attempt: job.attemptsMade + 1,
          error: err instanceof Error ? err.message : 'Unknown error',
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err; // Re-throw to trigger BullMQ retry
      }
    },
    {
      connection: redis,
      concurrency: parseInt(process.env['WORKER_CONCURRENCY'] ?? '5', 10),
      limiter: {
        max: 10,
        duration: 1000, // Max 10 jobs per second to avoid RPC rate limits
      },
    }
  );

  worker.on('completed', (job: Job<TransactionJobData>) => {
    logger.info('Transaction worker job completed', { jobId: job.id, txId: job.data.txId });
  });

  worker.on('failed', (job: Job<TransactionJobData> | undefined, err: Error) => {
    logger.error('Transaction worker job exhausted retries', {
      jobId: job?.id,
      txId: job?.data.txId,
      error: err.message,
    });
  });

  worker.on('error', (err: Error) => {
    logger.error('Transaction worker error', { error: err.message });
  });

  worker.on('stalled', (jobId: string) => {
    logger.warn('Transaction worker job stalled', { jobId });
  });

  return worker;
}
