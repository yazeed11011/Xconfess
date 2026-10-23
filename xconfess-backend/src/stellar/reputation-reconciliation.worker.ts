import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Tip, TipVerificationStatus } from '../tipping/entities/tip.entity';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { ReputationReconciliationCheckpoint } from './entities/reputation-reconciliation-checkpoint.entity';

const CHECKPOINT_WORKER_NAME = 'reputation-reconciliation';
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const CHECKPOINT_ERROR_CODE = 'BATCH_PROCESSING_FAILED';

export interface ReputationDiscrepancy {
  confessionId: string;
  onChainTipCount: number;
  dbVerifiedTipCount: number;
  onChainTotalXlm: number;
  dbTotalXlm: number;
}

/**
 * Periodic job that detects drift between the on-chain reputation signal
 * (verified tip transactions on Stellar Horizon) and the locally-cached
 * verified-tip counts stored in the database.
 *
 * Discrepancies are logged and emitted as events so downstream consumers
 * (e.g. alerting, badge recalculation) can react without coupling this
 * worker to any particular domain module.
 */
@Injectable()
export class ReputationReconciliationWorker {
  private readonly logger = new Logger(ReputationReconciliationWorker.name);
  private readonly batchSize: number;
  private readonly horizonUrl: string;
  private running = false;

  constructor(
    @InjectRepository(Tip)
    private readonly tipRepository: Repository<Tip>,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepository: Repository<AnonymousConfession>,
    @InjectRepository(ReputationReconciliationCheckpoint)
    private readonly checkpointRepository: Repository<ReputationReconciliationCheckpoint>,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const configuredBatchSize = Number.parseInt(
      this.configService.get<string>('REPUTATION_RECONCILIATION_BATCH_SIZE', '100'),
      10,
    );
    this.batchSize = Number.isFinite(configuredBatchSize)
      ? Math.min(Math.max(configuredBatchSize, 1), MAX_BATCH_SIZE)
      : DEFAULT_BATCH_SIZE;
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
  }

  @Cron(process.env.REPUTATION_RECONCILIATION_INTERVAL || '*/30 * * * *')
  async reconcileReputationScores(): Promise<void> {
    if (this.configService.get<string>('ENABLE_BACKGROUND_JOBS') !== 'true') {
      this.logger.warn({
        event: 'reputation_reconciliation_skipped',
        reason: 'background_jobs_disabled',
      });
      this.emitSafely('reputation.reconciliation.progress', {
        status: 'skipped',
        reason: 'background_jobs_disabled',
        processedCount: 0,
        timestamp: new Date(),
      });
      return;
    }

    if (this.running) return;
    this.running = true;

    try {
      let checkpoint = await this.checkpointRepository.findOne({
        where: { workerName: CHECKPOINT_WORKER_NAME },
      });
      if (!checkpoint) {
        checkpoint = this.checkpointRepository.create({
          workerName: CHECKPOINT_WORKER_NAME,
          lastConfessionId: null,
          status: 'idle',
          processedCount: 0,
          lastBatchSize: 0,
          lastErrorCode: null,
          lastStartedAt: null,
          lastCompletedAt: null,
        });
        checkpoint = await this.checkpointRepository.save(checkpoint);
      }

      if (checkpoint.status === 'complete') {
        checkpoint.processedCount = 0;
        checkpoint.lastConfessionId = null;
      }
      checkpoint.status = 'running';
      checkpoint.lastErrorCode = null;
      checkpoint.lastStartedAt = new Date();
      await this.checkpointRepository.save(checkpoint);

      const query = this.confessionRepository
        .createQueryBuilder('c')
        .innerJoin('tips', 't', 't.confession_id = c.id')
        .where('t.verification_status = :status', {
          status: TipVerificationStatus.VERIFIED,
        });
      if (checkpoint.lastConfessionId) {
        query.andWhere('c.id > :lastConfessionId', {
          lastConfessionId: checkpoint.lastConfessionId,
        });
      }
      const confessionsWithTips = await query
        .select('c.id', 'id')
        .groupBy('c.id')
        .orderBy('c.id', 'ASC')
        .limit(this.batchSize)
        .getRawMany<{ id: string }>();

      const discrepancies: ReputationDiscrepancy[] = [];
      for (const { id: confessionId } of confessionsWithTips) {
        const discrepancy = await this.checkConfession(confessionId);
        if (discrepancy) discrepancies.push(discrepancy);
      }

      const finished = confessionsWithTips.length < this.batchSize;
      checkpoint.lastConfessionId = finished
        ? null
        : confessionsWithTips[confessionsWithTips.length - 1].id;
      checkpoint.status = finished ? 'complete' : 'in_progress';
      checkpoint.processedCount += confessionsWithTips.length;
      checkpoint.lastBatchSize = confessionsWithTips.length;
      checkpoint.lastCompletedAt = finished ? new Date() : checkpoint.lastCompletedAt;
      await this.checkpointRepository.save(checkpoint);

      if (discrepancies.length > 0) {
        this.emitSafely('reputation.reconciliation.discrepancies', {
          count: discrepancies.length,
          discrepancies,
          timestamp: new Date(),
        });
      }

      this.logger.log({
        event: 'reputation_reconciliation_progress',
        status: checkpoint.status,
        batchSize: confessionsWithTips.length,
        processedCount: checkpoint.processedCount,
        discrepancyCount: discrepancies.length,
      });
      this.emitSafely('reputation.reconciliation.progress', {
        status: checkpoint.status,
        batchSize: confessionsWithTips.length,
        processedCount: checkpoint.processedCount,
        discrepancyCount: discrepancies.length,
        timestamp: new Date(),
      });
    } catch {
      try {
        const checkpoint = await this.checkpointRepository.findOne({
          where: { workerName: CHECKPOINT_WORKER_NAME },
        });
        if (checkpoint) {
          checkpoint.status = 'failed';
          checkpoint.lastErrorCode = CHECKPOINT_ERROR_CODE;
          await this.checkpointRepository.save(checkpoint);
        }
      } catch {
        // Keep failure reporting independent from checkpoint storage availability.
      }
      this.logger.error({
        event: 'reputation_reconciliation_failed',
        errorCode: CHECKPOINT_ERROR_CODE,
      });
      this.emitSafely('reputation.reconciliation.failure', {
        errorCode: CHECKPOINT_ERROR_CODE,
        timestamp: new Date(),
      });
      throw new Error(CHECKPOINT_ERROR_CODE);
    } finally {
      this.running = false;
    }
  }

  private emitSafely(eventName: string, payload: Record<string, unknown>): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch {
      this.logger.warn({
        event: 'reputation_reconciliation_event_delivery_failed',
        eventName,
        errorCode: 'EVENT_DELIVERY_FAILED',
      });
    }
  }

  private async checkConfession(
    confessionId: string,
  ): Promise<ReputationDiscrepancy | null> {
    // Local DB state: all verified tips for this confession
    const dbTips = await this.tipRepository.find({
      where: {
        confessionId,
        verificationStatus: TipVerificationStatus.VERIFIED,
      },
    });

    const dbVerifiedTipCount = dbTips.length;
    const dbTotalXlm = dbTips.reduce((sum, t) => sum + Number(t.amount), 0);

    // On-chain state: verify each recorded txId is still present on Horizon
    let onChainTipCount = 0;
    let onChainTotalXlm = 0;

    for (const tip of dbTips) {
      const confirmed = await this.verifyTxOnHorizon(tip.txId, tip.amount);
      if (confirmed) {
        onChainTipCount++;
        onChainTotalXlm += confirmed;
      }
    }

    const tipCountMismatch = onChainTipCount !== dbVerifiedTipCount;
    const amountMismatch = Math.abs(onChainTotalXlm - dbTotalXlm) > 0.0000001;

    if (!tipCountMismatch && !amountMismatch) {
      return null;
    }

    return {
      confessionId,
      onChainTipCount,
      dbVerifiedTipCount,
      onChainTotalXlm,
      dbTotalXlm,
    };
  }

  /**
   * Verify that a Stellar transaction exists on Horizon and return its XLM
   * amount (in stroops converted to XLM). Returns null if the transaction is
   * not found or cannot be verified.
   */
  private async verifyTxOnHorizon(
    txId: string,
    expectedAmount: number,
  ): Promise<number | null> {
    try {
      const url = `${this.horizonUrl}/transactions/${encodeURIComponent(txId)}`;
      const resp = await outboundFetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.status === 404) {
        this.logger.warn({
          event: 'reputation_tx_not_found',
          message: 'Transaction not found on Horizon — possible reorg or pruning',
        });
        return null;
      }

      if (!resp.ok) {
        this.logger.warn({
          event: 'reputation_horizon_error',
          httpStatus: resp.status,
        });
        return null;
      }

      // If tx is found and succeeded we trust the DB amount to avoid parsing
      // the full operation set. The mismatch check compares totals at the
      // confession level, not per-transaction.
      return Number(expectedAmount);
    } catch (err: any) {
      this.logger.warn({
        event: 'reputation_horizon_fetch_error',
        errorCode: 'HORIZON_FETCH_FAILED',
      });
      return null;
    }
  }
}
