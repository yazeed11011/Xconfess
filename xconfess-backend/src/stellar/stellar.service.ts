import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSDK from '@stellar/stellar-sdk';
import { StellarConfigService } from './stellar-config.service';
import { TransactionBuilderService } from './transaction-builder.service';
import { DeploymentMetadataService } from './services/deployment-metadata.service';
import { ITransactionResult } from './interfaces/stellar-config.interface';
import { StellarConfigResponseDto } from './dto/stellar-config-response.dto';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnonymousConfession } from '../confession/entities/confession.entity';
import { redactSecretStrings } from '../utils/redact-secrets';
import {
  StellarEndpointPool,
  StellarEndpointPoolError,
} from './stellar-endpoint-pool.service';
import {
  combineSignals,
  isCancelled,
} from '../common/cancellation/cancellation';
import { CancellationContext } from '../common/cancellation/cancellation-context';

export interface AnchorData {
  stellarTxHash: string;
  stellarHash: string;
  anchoredAt: Date;
}

/**
 * Lifecycle of a transaction submission keyed by its operation intent.
 *
 * - `pending`: the submission was attempted but the outcome is unknown
 *   (e.g. a network timeout). The record is durable so a retry can reconcile
 *   against the network instead of blindly re-submitting.
 * - `submitted`: the network accepted the transaction and returned a hash.
 * - `confirmed`: the transaction was observed on-chain.
 * - `failed`: the submission definitively failed and may be retried.
 */
export type PendingSubmissionStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed';

export interface PendingSubmissionRecord {
  /** Deterministic key derived from the operation intent. */
  intentKey: string;
  status: PendingSubmissionStatus;
  /** Transaction hash, known once the network accepts the submission. */
  txHash?: string;
  /** Serialized intent payload used to detect conflicting retries. */
  intent: string;
  attempts: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmissionIntent {
  /** Logical operation kind, e.g. `tip` or `anchor`. */
  operation: string;
  /** Stable identifier of the target resource (confession id, tip id, ...). */
  resourceId: string;
  /** Optional additional discriminator (e.g. recipient public key). */
  discriminator?: string;
}

export interface ReconcileResult {
  record: PendingSubmissionRecord;
  /** True when the transaction is known to be on-chain. */
  confirmed: boolean;
  /** True when the caller may safely (re)submit the operation. */
  safeToRetry: boolean;
}

/**
 * Bounded label sets for transaction latency metrics. Keeping these closed
 * prevents unbounded cardinality in downstream metric stores.
 */
export const TX_LATENCY_NETWORKS = ['mainnet', 'testnet', 'futurenet', 'unknown'] as const;
export type TxLatencyNetwork = (typeof TX_LATENCY_NETWORKS)[number];

export const TX_LATENCY_OPERATIONS = [
  'payment',
  'anchor',
  'verification',
  'balance',
  'other',
] as const;
export type TxLatencyOperation = (typeof TX_LATENCY_OPERATIONS)[number];

export const TX_LATENCY_PHASES = [
  'submission',
  'inclusion',
  'confirmation',
] as const;
export type TxLatencyPhase = (typeof TX_LATENCY_PHASES)[number];

export interface TxLatencyBudget {
  /** Soft budget: breaches are logged as warnings. */
  warnMs: number;
  /** Hard budget: breaches are logged as errors and flagged for alerting. */
  criticalMs: number;
}

export interface TxLatencySample {
  network: TxLatencyNetwork;
  operation: TxLatencyOperation;
  phase: TxLatencyPhase;
  durationMs: number;
  success: boolean;
  breach: 'none' | 'warn' | 'critical';
}

export interface TxLatencySnapshot {
  network: TxLatencyNetwork;
  operation: TxLatencyOperation;
  phase: TxLatencyPhase;
  count: number;
  failures: number;
  breaches: number;
  criticalBreaches: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

const DEFAULT_LATENCY_BUDGETS: Record<TxLatencyPhase, TxLatencyBudget> = {
  submission: { warnMs: 2_000, criticalMs: 5_000 },
  inclusion: { warnMs: 10_000, criticalMs: 30_000 },
  confirmation: { warnMs: 15_000, criticalMs: 45_000 },
};

@Injectable()
export class StellarService {
  private readonly logger = new Logger(StellarService.name);
  private readonly contractId: string;
  private readonly network: string;
  private readonly horizonUrl: string;
  /**
   * Durable-by-contract store of submission intents. In production this is
   * backed by the persistence layer; the in-memory map is the owning
   * boundary's fallback so ambiguous outcomes are never silently dropped.
   */
  private readonly pendingSubmissions = new Map<
    string,
    PendingSubmissionRecord
  >();
  private readonly latencyBudgets: Record<TxLatencyPhase, TxLatencyBudget>;
  private readonly latencySamples = new Map<string, TxLatencySnapshot>();

  constructor(
    private readonly configService: ConfigService,
    private stellarConfig: StellarConfigService,
    private txBuilder: TransactionBuilderService,
    private deploymentMetadataService: DeploymentMetadataService,
    private readonly endpointPool: StellarEndpointPool,
    @InjectRepository(AnonymousConfession)
    private readonly confessionRepo: Repository<AnonymousConfession>,
    finalityRepository?: TransactionFinalityRepository,
  ) {
    this.contractId = this.configService.get<string>(
      'CONFESSION_ANCHOR_CONTRACT',
      'CCHDY246UUPY6VUGIDVSK266KXA64CXM6RR2QLTKJD7E7IGV74ZP5XFB',
    );
    this.network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
    this.latencyBudgets = this.loadLatencyBudgets();
  }

  /**
   * Resolve per-phase latency budgets from configuration, falling back to
   * conservative defaults. Invalid values are ignored with a warning so a bad
   * env var cannot silently disable breach detection.
   */
  private loadLatencyBudgets(): Record<TxLatencyPhase, TxLatencyBudget> {
    const budgets: Record<TxLatencyPhase, TxLatencyBudget> = {
      submission: { ...DEFAULT_LATENCY_BUDGETS.submission },
      inclusion: { ...DEFAULT_LATENCY_BUDGETS.inclusion },
      confirmation: { ...DEFAULT_LATENCY_BUDGETS.confirmation },
    };

    for (const phase of TX_LATENCY_PHASES) {
      const envKey = `STELLAR_TX_LATENCY_${phase.toUpperCase()}_BUDGET_MS`;
      const raw = this.configService.get<string | number>(envKey);
      if (raw === undefined || raw === null || raw === '') {
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        this.logger.warn(
          `Ignoring invalid ${envKey}="${String(raw)}"; using default budget`,
        );
        continue;
      }
      const warnMs = parsed;
      const criticalMs = Math.max(
        warnMs,
        Math.round(warnMs * 2.5),
      );
      budgets[phase] = { warnMs, criticalMs };
    }

    return budgets;
  }

  /**
   * Normalize the configured network into a bounded label value.
   */
  private getLatencyNetworkLabel(): TxLatencyNetwork {
    const normalized = (this.network || '').toLowerCase();
    return (TX_LATENCY_NETWORKS as readonly string[]).includes(normalized)
      ? (normalized as TxLatencyNetwork)
      : 'unknown';
  }

  /**
   * Normalize an operation class into a bounded label value.
   */
  private getLatencyOperationLabel(
    operation: TxLatencyOperation | string,
  ): TxLatencyOperation {
    const normalized = (operation || '').toLowerCase();
    return (TX_LATENCY_OPERATIONS as readonly string[]).includes(normalized)
      ? (normalized as TxLatencyOperation)
      : 'other';
  }

  private getLatencyKey(
    network: TxLatencyNetwork,
    operation: TxLatencyOperation,
    phase: TxLatencyPhase,
  ): string {
    return `${network}|${operation}|${phase}`;
  }

  /**
   * Record a single latency observation, compare it against the configured
   * budget for the phase, and emit structured logs / alert signals on breach.
   * Failure paths are measured the same way as successes so degraded
   * providers are visible even when transactions never complete.
   */
  recordTransactionLatency(
    operation: TxLatencyOperation | string,
    phase: TxLatencyPhase,
    durationMs: number,
    success: boolean,
  ): TxLatencySample {
    const network = this.getLatencyNetworkLabel();
    const opLabel = this.getLatencyOperationLabel(operation);
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : 0;
    const budget = this.latencyBudgets[phase];

    let breach: TxLatencySample['breach'] = 'none';
    if (safeDuration >= budget.criticalMs) {
      breach = 'critical';
    } else if (safeDuration >= budget.warnMs) {
      breach = 'warn';
    }

    const key = this.getLatencyKey(network, opLabel, phase);
    const existing = this.latencySamples.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalMs += safeDuration;
      existing.maxMs = Math.max(existing.maxMs, safeDuration);
      existing.lastMs = safeDuration;
      if (!success) {
        existing.failures += 1;
      }
      if (breach !== 'none') {
        existing.breaches += 1;
      }
      if (breach === 'critical') {
        existing.criticalBreaches += 1;
      }
    } else {
      this.latencySamples.set(key, {
        network,
        operation: opLabel,
        phase,
        count: 1,
        failures: success ? 0 : 1,
        breaches: breach === 'none' ? 0 : 1,
        criticalBreaches: breach === 'critical' ? 1 : 0,
        totalMs: safeDuration,
        maxMs: safeDuration,
        lastMs: safeDuration,
      });
    }

    const logPayload = {
      metric: 'stellar_tx_latency_ms',
      network,
      operation: opLabel,
      phase,
      durationMs: Math.round(safeDuration),
      success,
      breach,
      warnBudgetMs: budget.warnMs,
      criticalBudgetMs: budget.criticalMs,
    };

    if (breach === 'critical') {
      this.logger.error({
        ...logPayload,
        message: `Stellar ${phase} latency exceeded critical budget`,
        alert: true,
      });
    } else if (breach === 'warn') {
      this.logger.warn({
        ...logPayload,
        message: `Stellar ${phase} latency exceeded warning budget`,
      });
    } else {
      this.logger.debug(logPayload);
    }

    return {
      network,
      operation: opLabel,
      phase,
      durationMs: safeDuration,
      success,
      breach,
    };
  }

  /**
   * Run an async operation while measuring its latency for the given phase.
   * The original result or error is always propagated unchanged.
   */
  private async measurePhase<T>(
    operation: TxLatencyOperation,
    phase: TxLatencyPhase,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    let success = false;
    try {
      const result = await fn();
      success = true;
      return result;
    } finally {
      this.recordTransactionLatency(
        operation,
        phase,
        Date.now() - startedAt,
        success,
      );
    }
  }

  /**
   * Snapshot of aggregated latency metrics for observability endpoints/tests.
   */
  getTransactionLatencySnapshot(): TxLatencySnapshot[] {
    return Array.from(this.latencySamples.values()).map((s) => ({ ...s }));
  }

  /**
   * Reset aggregated latency metrics (used by tests and on config reload).
   */
  resetTransactionLatencyMetrics(): void {
    this.latencySamples.clear();
  }

  /**
   * Get account balance
   */
  async getAccountBalance(publicKey: string): Promise<{
    native: string;
    assets: Array<{ code: string; issuer: string; balance: string }>;
  }> {
    try {
      const account = await this.endpointPool.executeRead((server) =>
        server.loadAccount(publicKey),
      );
      const native =
        account.balances.find((b) => b.asset_type === 'native')?.balance || '0';
      const assets = account.balances
        .filter((b) => b.asset_type !== 'native')
        .map((b: any) => ({
          code: b.asset_code,
          issuer: b.asset_issuer,
          balance: b.balance,
        }));
      return { native, assets };
    } catch (error: unknown) {
      const message = this.describePoolError(error);
      this.logger.error(`Failed to get account balance: ${message}`);
      throw new AppException(
        `Account not found or network error: ${message}`,
        ErrorCode.STELLAR_ERROR,
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * Verify transaction on-chain (full result) with bounded retries
   */
  async verifyTransactionFull(txHash: string): Promise<ITransactionResult> {
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const tx = await this.endpointPool.executeRead((server) =>
          this.measurePhase('verification', 'inclusion', () =>
            server.transactions().transaction(txHash).call(),
          ),
        );
        return {
          hash: tx.hash,
          success: tx.successful,
          ledger: tx.ledger as any,
          createdAt: tx.created_at,
          envelope: tx.envelope_xdr,
          result: tx.result_xdr,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isRetryable =
          message.toLowerCase().includes('timeout') ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.error(`Transaction verification failed: ${message}`);
          throw new AppException(
            `Transaction not found: ${message}`,
            ErrorCode.NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        this.logger.warn(
          `verifyTransactionFull failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`,
        );
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  /**
   * Check if account exists
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.endpointPool.executeRead((server) =>
        server.loadAccount(publicKey),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get network configuration (safe for public exposure; never includes secrets).
   */
  getNetworkConfig(): StellarConfigResponseDto {
    const config = this.stellarConfig.getConfig();
    const metadataFreshness = this.deploymentMetadataService.getMetadataFreshness();
    return {
      network: config.network,
      horizonUrl: config.horizonUrl,
      sorobanRpcUrl: config.sorobanRpcUrl,
      contractIds: {
        confessionAnchor: config.contractIds.confessionAnchor ?? null,
        reputationBadges: config.contractIds.reputationBadges ?? null,
        tippingSystem: config.contractIds.tippingSystem ?? null,
      },
      deploymentMetadata: {
        loaded: !!this.deploymentMetadataService.getMetadata(),
        generatedAtUtc: metadataFreshness.generatedAtUtc,
        isStale: metadataFreshness.isStale,
        ageDays:
          metadataFreshness.daysSinceGeneration >= 0
            ? metadataFreshness.daysSinceGeneration
            : null,
        loadError: this.deploymentMetadataService.getLoadError(),
      },
    };
  }

  /**
   * Send payment
   */
  async sendPayment(
    destinationPublicKey: string,
    amount: string,
    memo?: string,
  ): Promise<ITransactionResult> {
    try {
      const serverSecret = this.configService.get('STELLAR_SERVER_SECRET');
      if (!serverSecret) {
        throw new AppException(
          'Server secret key not configured',
          ErrorCode.INTERNAL_SERVER_ERROR,
        );
      }
      const serverKeypair = StellarSDK.Keypair.fromSecret(serverSecret);
      const tx = await this.txBuilder.buildPaymentTransaction(
        serverKeypair.publicKey(),
        destinationPublicKey,
        amount,
        StellarSDK.Asset.native(),
        { memo },
      );
      const signedTx = this.txBuilder.signTransaction(tx, serverSecret);
      const result = await this.measurePhase('payment', 'submission', () =>
        this.endpointPool.executeSubmit(() =>
          this.txBuilder.submitTransaction(signedTx),
        ),
      );
      return {
        hash: result.hash,
        success: result.successful,
      };
    } catch (error: unknown) {
      // Redacted defensively: this path constructs a keypair directly from
      // the server secret, so any thrown error is not guaranteed secret-free.
      const message = redactSecretStrings(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(`Payment failed: ${message}`);
      throw error;
    }
  }

  /**
   * Derive a deterministic, collision-resistant key from an operation intent.
   * Retries of the same logical operation always map to the same key, which
   * is what makes reconciliation idempotent.
   */
  deriveIntentKey(intent: SubmissionIntent): string {
    if (!intent || !intent.operation || !intent.resourceId) {
      throw new AppException(
        'Submission intent requires operation and resourceId',
        ErrorCode.VALIDATION_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }
    const payload = JSON.stringify({
      operation: intent.operation,
      resourceId: intent.resourceId,
      discriminator: intent.discriminator ?? null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Look up the durable pending-submission record for an intent, if any.
   */
  getPendingSubmission(
    intent: SubmissionIntent,
  ): PendingSubmissionRecord | undefined {
    return this.pendingSubmissions.get(this.deriveIntentKey(intent));
  }

  /**
   * Record that a submission was attempted but its outcome is ambiguous.
   * Idempotent: repeated calls for the same intent only bump the attempt
   * counter and preserve any previously observed transaction hash.
   */
  recordPendingSubmission(
    intent: SubmissionIntent,
    error?: unknown,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const now = new Date();
    const existing = this.pendingSubmissions.get(intentKey);
    const message =
      error === undefined
        ? undefined
        : redactSecretStrings(
            error instanceof Error ? error.message : String(error),
          );

    const record: PendingSubmissionRecord = existing
      ? {
          ...existing,
          status: existing.txHash ? 'submitted' : 'pending',
          attempts: existing.attempts + 1,
          lastError: message ?? existing.lastError,
          updatedAt: now,
        }
      : {
          intentKey,
          status: 'pending',
          intent: JSON.stringify(intent),
          attempts: 1,
          lastError: message,
          createdAt: now,
          updatedAt: now,
        };

    this.pendingSubmissions.set(intentKey, record);
    this.logger.warn(
      `Recorded ambiguous submission for intent ${intentKey} (attempt ${record.attempts})`,
    );
    return record;
  }

  /**
   * Record a successful submission (network accepted the transaction).
   */
  recordSubmittedTransaction(
    intent: SubmissionIntent,
    txHash: string,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const now = new Date();
    const existing = this.pendingSubmissions.get(intentKey);
    const record: PendingSubmissionRecord = {
      intentKey,
      status: 'submitted',
      txHash,
      intent: JSON.stringify(intent),
      attempts: existing ? existing.attempts + 1 : 1,
      lastError: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);
    return record;
  }

  /**
   * Reconcile an ambiguous submission against the network before retrying.
   *
   * - If a transaction hash is already known, verify it on-chain.
   * - If no hash is known, the caller may safely retry (no evidence of a
   *   prior accepted submission).
   *
   * This is the single authoritative check that prevents duplicate tipping
   * or anchoring when a retry follows a timeout.
   */
  async reconcileSubmission(
    intent: SubmissionIntent,
    requestId?: string,
  ): Promise<ReconcileResult> {
    const intentKey = this.deriveIntentKey(intent);
    const existing = this.pendingSubmissions.get(intentKey);

    if (!existing) {
      return {
        record: {
          intentKey,
          status: 'pending',
          intent: JSON.stringify(intent),
          attempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        confirmed: false,
        safeToRetry: true,
      };
    }

    if (!existing.txHash) {
      return { record: existing, confirmed: false, safeToRetry: true };
    }

    const confirmed = await this.verifyTransaction(existing.txHash, requestId);
    const now = new Date();
    const record: PendingSubmissionRecord = {
      ...existing,
      status: confirmed ? 'confirmed' : existing.status,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);

    return {
      record,
      confirmed,
      // A known-but-unconfirmed hash must not be re-submitted blindly.
      safeToRetry: false,
    };
  }

  /**
   * Mark a submission as definitively failed so a retry is authorized.
   */
  markSubmissionFailed(
    intent: SubmissionIntent,
    error?: unknown,
  ): PendingSubmissionRecord {
    const intentKey = this.deriveIntentKey(intent);
    const existing = this.pendingSubmissions.get(intentKey);
    const now = new Date();
    const message =
      error === undefined
        ? undefined
        : redactSecretStrings(
            error instanceof Error ? error.message : String(error),
          );
    const record: PendingSubmissionRecord = {
      intentKey,
      status: 'failed',
      txHash: existing?.txHash,
      intent: JSON.stringify(intent),
      attempts: existing?.attempts ?? 1,
      lastError: message ?? existing?.lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.pendingSubmissions.set(intentKey, record);
    return record;
  }

  /**
   * Generate SHA-256 hash of confession content for anchoring
   */
  hashConfession(content: string, timestamp?: number): string {
    const ts = timestamp || Date.now();
    const payload = JSON.stringify({ content, timestamp: ts });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Validate a Stellar transaction hash format
   */
  isValidTxHash(txHash: string): boolean {
    if (!txHash || typeof txHash !== 'string') {
      return false;
    }
    return /^[a-fA-F0-9]{64}$/.test(txHash);
  }

  /**
   * Build the Stellar Explorer URL for a transaction
   */
  getExplorerUrl(txHash: string): string {
    const baseUrl =
      this.network === 'mainnet'
        ? 'https://stellar.expert/explorer/public/tx'
        : 'https://stellar.expert/explorer/testnet/tx';
    return `${baseUrl}/${txHash}`;
  }

  /**
   * Build the Horizon API URL for a transaction
   */
  getHorizonTxUrl(txHash: string): string {
    return `${this.horizonUrl}/transactions/${txHash}`;
  }

  /**
   * Verify a transaction exists on the Stellar network
   *
   * The request cancellation signal (issue #182) is combined with the RPC
   * timeout so a disconnected client stops the provider call instead of
   * keeping the connection busy for a result nobody will read.
   */
  async verifyTransaction(txHash: string, requestId?: string): Promise<boolean> {
    if (!this.isValidTxHash(txHash)) {
      return false;
    }

    const callerSignal = CancellationContext.getSignal();
    if (isCancelled(callerSignal)) {
      return false;
    }

    try {
      const data = await this.endpointPool.executeRead(async (server) => {
        const controller = new AbortController();
        const timeoutMs = this.stellarConfig.getConfig().rpcTimeoutMs;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const combined = combineSignals([controller.signal, callerSignal]);
        try {
          const response = await this.measurePhase(
            'verification',
            'confirmation',
            () =>
              fetch(`${server.serverURL}/transactions/${txHash}`, {
                signal: combined.signal,
              }),
          );
          if (!response.ok) {
            return null;
          }
          return (await response.json()) as { successful?: boolean };
        } finally {
          clearTimeout(timeoutId);
          combined.dispose();
        }
      });

      return data?.successful === true;
    } catch (error: unknown) {
      if (isCancelled(callerSignal)) {
        this.logger.warn({
          message: 'Stellar transaction verification cancelled by the caller',
          requestId,
          txHash,
        });
        return false;
      }
      this.logger.error({
        message: `Error verifying Stellar transaction: ${this.describePoolError(error)}`,
        requestId,
        txHash,
      });
      return false;
    }
  }

  /**
   * Normalize an endpoint-pool failure into a safe, log-friendly message.
   */
  private describePoolError(error: unknown): string {
    if (error instanceof StellarEndpointPoolError) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Record that a transaction has been accepted (submitted) by the network.
   *
   * This only establishes the ACCEPTED baseline; it never promotes a
   * transaction to INCLUDED/FINALIZED without verified ledger evidence.
   */
  async recordAccepted(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.finalityRepository.find(txHash);
    if (existing && existing.state !== TransactionFinalityState.UNKNOWN) {
      // Never downgrade a verified state back to ACCEPTED.
      return existing;
    }

    const now = new Date();
    const record: TransactionFinalityRecord = {
      txHash,
      state: TransactionFinalityState.ACCEPTED,
      ledger: existing?.ledger ?? null,
      resultCode: existing?.resultCode ?? null,
      replacementHashes: existing?.replacementHashes ?? [],
      replacesHash: existing?.replacesHash ?? null,
      lastObservedAt: existing?.lastObservedAt ?? null,
      updatedAt: now,
    };
    return this.finalityRepository.save(record);
  }

  /**
   * Observe a transaction on the network and persist verified evidence.
   *
   * Only verified observations promote state:
   *  - included at ledger depth >= confirmationDepth -> FINALIZED
   *  - included but below confirmation depth          -> INCLUDED
   *  - included with a failing result code            -> FAILED
   *  - missing / ambiguous / conflicting evidence     -> UNKNOWN (no promotion)
   */
  async observeTransaction(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.finalityRepository.find(txHash);
    const observation = await this.fetchObservation(txHash);
    const now = new Date();

    const base: TransactionFinalityRecord = existing ?? {
      txHash,
      state: TransactionFinalityState.UNKNOWN,
      ledger: null,
      resultCode: null,
      replacementHashes: [],
      replacesHash: null,
      lastObservedAt: null,
      updatedAt: now,
    };

    if (!observation.verified) {
      // Ambiguous or missing evidence: keep any previously verified state,
      // otherwise remain UNKNOWN. Never promote on unverified data.
      const next: TransactionFinalityRecord = {
        ...base,
        state:
          base.state === TransactionFinalityState.ACCEPTED
            ? TransactionFinalityState.ACCEPTED
            : base.state,
        lastObservedAt: now,
        updatedAt: now,
      };
      return this.finalityRepository.save(next);
    }

    // Conflicting observation: a previously finalized/included record that now
    // reports a different ledger is treated as untrusted and left untouched.
    if (
      base.ledger !== null &&
      observation.ledger !== null &&
      base.ledger !== observation.ledger &&
      (base.state === TransactionFinalityState.FINALIZED ||
        base.state === TransactionFinalityState.INCLUDED)
    ) {
      this.logger.warn(
        `Conflicting ledger observation for ${txHash}: recorded ${base.ledger}, observed ${observation.ledger}`,
      );
      const next: TransactionFinalityRecord = {
        ...base,
        lastObservedAt: now,
        updatedAt: now,
      };
      return this.finalityRepository.save(next);
    }

    const nextState = this.resolveState(observation);
    const next: TransactionFinalityRecord = {
      ...base,
      state: nextState,
      ledger: observation.ledger ?? base.ledger,
      resultCode: observation.resultCode ?? base.resultCode,
      lastObservedAt: now,
      updatedAt: now,
    };
    return this.finalityRepository.save(next);
  }

  /**
   * Read the current verified finality state for a transaction.
   */
  async getFinality(txHash: string): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(txHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const record = await this.finalityRepository.find(txHash);
    if (record) {
      return record;
    }

    return {
      txHash,
      state: TransactionFinalityState.UNKNOWN,
      ledger: null,
      resultCode: null,
      replacementHashes: [],
      replacesHash: null,
      lastObservedAt: null,
      updatedAt: new Date(),
    };
  }

  /**
   * Link a fee-bump replacement hash to the logical transaction it replaces so
   * that the user-facing ledger records a single logical operation.
   */
  async recordReplacement(
    originalHash: string,
    replacementHash: string,
  ): Promise<TransactionFinalityRecord> {
    if (!this.isValidTxHash(originalHash) || !this.isValidTxHash(replacementHash)) {
      throw new AppException(
        'Invalid transaction hash',
        ErrorCode.STELLAR_ERROR,
        HttpStatus.BAD_REQUEST,
      );
    }

    const original =
      (await this.finalityRepository.find(originalHash)) ??
      (await this.recordAccepted(originalHash));

    const replacementHashes = original.replacementHashes.includes(replacementHash)
      ? original.replacementHashes
      : [...original.replacementHashes, replacementHash];

    const updated = await this.finalityRepository.save({
      ...original,
      replacementHashes,
      updatedAt: new Date(),
    });

    // Ensure the replacement hash resolves to the same logical record.
    const replacementRecord = await this.finalityRepository.find(replacementHash);
    await this.finalityRepository.save({
      txHash: replacementHash,
      state: replacementRecord?.state ?? TransactionFinalityState.ACCEPTED,
      ledger: replacementRecord?.ledger ?? null,
      resultCode: replacementRecord?.resultCode ?? null,
      replacementHashes: updated.replacementHashes,
      replacesHash: originalHash,
      lastObservedAt: replacementRecord?.lastObservedAt ?? null,
      updatedAt: new Date(),
    });

    return updated;
  }

  /**
   * Fetch a single observation from Horizon and classify its trustworthiness.
   */
  private async fetchObservation(txHash: string): Promise<TransactionObservation> {
    const observedAt = new Date();
    const rpcConfig = this.stellarConfig.getConfig();
    const maxRetries = rpcConfig.rpcMaxRetries;
    const baseDelay = rpcConfig.rpcRetryBaseDelayMs;
    const maxDelay = rpcConfig.rpcRetryMaxDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          rpcConfig.rpcTimeoutMs,
        );

        let response: Response;
        try {
          response = await outboundFetch(this.getHorizonTxUrl(txHash), {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (response.status === 404) {
          // Not yet visible: a delayed observation, not a failure.
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: 'not_found',
            observedAt,
          };
        }

        if (!response.ok) {
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: `http_${response.status}`,
            observedAt,
          };
        }

        const data: any = await response.json();
        const ledger =
          typeof data.ledger === 'number' && data.ledger > 0 ? data.ledger : null;
        const successful =
          typeof data.successful === 'boolean' ? data.successful : null;
        const resultCode =
          typeof data.result_code === 'string' ? data.result_code : null;

        // Evidence is only trusted when a ledger inclusion is reported.
        if (ledger === null || successful === null) {
          return {
            txHash,
            ledger,
            successful,
            resultCode,
            verified: false,
            reason: 'incomplete_evidence',
            observedAt,
          };
        }

        return {
          txHash,
          ledger,
          successful,
          resultCode,
          verified: true,
          observedAt,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const isAbort =
          error instanceof DOMException && error.name === 'AbortError';
        const isRetryable =
          isAbort ||
          message.toLowerCase().includes('econnrefused') ||
          message.toLowerCase().includes('econnreset') ||
          message.toLowerCase().includes('network');

        if (!isRetryable || attempt >= maxRetries) {
          this.logger.error(
            `Finality observation failed for ${txHash}: ${message}`,
          );
          return {
            txHash,
            ledger: null,
            successful: null,
            resultCode: null,
            verified: false,
            reason: 'rpc_error',
            observedAt,
          };
        }

        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        await new Promise((res) => setTimeout(res, delay));
      }
    }

    return {
      txHash,
      ledger: null,
      successful: null,
      resultCode: null,
      verified: false,
      reason: 'exhausted_retries',
      observedAt,
    };
  }

  /**
   * Map a verified observation to a finality state.
   */
  private resolveState(
    observation: TransactionObservation,
  ): TransactionFinalityState {
    if (!observation.verified || observation.ledger === null) {
      return TransactionFinalityState.UNKNOWN;
    }

    if (observation.successful === false) {
      return TransactionFinalityState.FAILED;
    }

    const currentLedger = this.getLatestKnownLedger(observation.ledger);
    const depth = currentLedger - observation.ledger + 1;
    if (depth >= this.confirmationDepth) {
      return TransactionFinalityState.FINALIZED;
    }
    return TransactionFinalityState.INCLUDED;
  }

  /**
   * Determine the latest ledger used to compute confirmation depth. The
   * observation's own ledger is the conservative lower bound; callers may
   * override via configuration for deterministic testing.
   */
  private getLatestKnownLedger(observedLedger: number): number {
    const configured = Number(
      this.configService.get<string | number>('STELLAR_LATEST_LEDGER', 0),
    );
    if (Number.isFinite(configured) && configured >= observedLedger) {
      return Math.floor(configured);
    }
    return observedLedger;
  }

  /**
   * Process anchoring data from frontend
   */
  processAnchorData(
    confessionContent: string,
    txHash: string,
    timestamp?: number,
  ): AnchorData | null {
    if (!this.isValidTxHash(txHash)) {
      return null;
    }

    const stellarHash = this.hashConfession(confessionContent, timestamp);

    return {
      stellarTxHash: txHash,
      stellarHash,
      anchoredAt: new Date(),
    };
  }

  /**
   * Get contract configuration info
   */
  getContractInfo(): {
    contractId: string;
    network: string;
    horizonUrl: string;
  } {
    return {
      contractId: this.contractId,
      network: this.network,
      horizonUrl: this.horizonUrl,
    };
  }

  /**
   * Get paginated anchored confessions for a user
   */
  async getUserAnchors(
    userId: number,
    page: number = 1,
    limit: number = 10,
  ): Promise<{
    data: Array<{
      confessionId: string;
      stellarTxHash: string;
      stellarHash: string;
      anchoredAt: Date;
      contractId: string;
      stellarExplorerUrl: string;
      message: string;
    }>;
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [confessions, total] = await this.confessionRepo
      .createQueryBuilder('confession')
      .innerJoin('confession.anonymousUser', 'anonUser')
      .innerJoin('anonUser.userLinks', 'userLink')
      .innerJoin('userLink.user', 'user')
      .where('user.id = :userId', { userId })
      .andWhere('confession.isAnchored = true')
      .andWhere('confession.isDeleted = false')
      .orderBy('confession.anchoredAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const data = confessions.map((conf) => ({
      confessionId: conf.id,
      stellarTxHash: conf.stellarTxHash,
      stellarHash: conf.stellarHash,
      anchoredAt: conf.anchoredAt,
      contractId: this.contractId,
      stellarExplorerUrl: this.getExplorerUrl(conf.stellarTxHash),
      message: '',
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
