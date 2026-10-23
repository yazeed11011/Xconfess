import * as Joi from 'joi';

const productionLike = Joi.valid('production', 'staging');
const productionHexKey = Joi.string()
  .hex()
  .length(64)
  .invalid('0000000000000000000000000000000000000000000000000000000000000000');

/**
 * Network isolation helpers.
 *
 * Testnet and mainnet configuration must never be mixed: a production signer
 * pointed at testnet, or a testnet contract ID deployed to mainnet, is a
 * critical misconfiguration. These helpers are exported so the negative tests
 * can assert the exact same rules the schema enforces.
 */
export const STELLAR_NETWORKS = ['testnet', 'mainnet'] as const;
export type StellarNetwork = (typeof STELLAR_NETWORKS)[number];

const TESTNET_HOST_MARKERS = ['testnet', 'testnet2', 'futurenet', 'sandbox'];
const MAINNET_HOST_MARKERS = ['mainnet', 'public'];

/** Returns true when a URL host looks like a testnet endpoint. */
export function isTestnetEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return TESTNET_HOST_MARKERS.some((marker) => lower.includes(marker));
}

/** Returns true when a URL host looks like a mainnet endpoint. */
export function isMainnetEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return MAINNET_HOST_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Stellar contract IDs are network-agnostic strings, so we cannot derive the
 * network from the ID itself. Instead we require operators to declare the
 * network the IDs were deployed to via STELLAR_CONTRACT_NETWORK and reject any
 * mismatch with STELLAR_NETWORK.
 */
export function contractNetworkMismatch(
  declaredNetwork: string | undefined,
  stellarNetwork: string | undefined,
): boolean {
  if (!declaredNetwork || !stellarNetwork) return false;
  return declaredNetwork !== stellarNetwork;
}

/**
 * Centralized environment-variable validation schema.
 *
 * Called by ConfigModule.forRoot() at bootstrap.
 * If any required variable is missing or invalid the app exits
 * immediately with an actionable error message.
 */
export const envValidationSchema = Joi.object({
  // â”€â”€ Core â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  NODE_ENV: Joi.string()
    .valid('development', 'dev', 'local', 'production', 'test', 'ci', 'staging')
    .default('development'),
  APP_ENV: Joi.string().optional(),
  PORT: Joi.number().port().default(3000),
  MODERATION_PROVIDER_TIMEOUT_MS: Joi.number().min(500).max(10000).default(5000),
  MODERATION_PROVIDER_MAX_ATTEMPTS: Joi.number().integer().min(1).max(3).default(2),
  MAIL_CONNECTION_TIMEOUT_MS: Joi.number().min(500).max(30000).default(5000),
  MAIL_GREETING_TIMEOUT_MS: Joi.number().min(500).max(30000).default(5000),
  MAIL_SOCKET_TIMEOUT_MS: Joi.number().min(500).max(30000).default(10000),

  // â”€â”€ Database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  DB_HOST: Joi.string().required().messages({
    'any.required': 'DB_HOST is required â€“ set the PostgreSQL hostname.',
  }),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required().messages({
    'any.required': 'DB_USERNAME is required â€“ set the PostgreSQL user.',
  }),
  DB_PASSWORD: Joi.string().required().allow('').messages({
    'any.required': 'DB_PASSWORD is required â€“ set the PostgreSQL password.',
  }),
  DB_NAME: Joi.string().required().messages({
    'any.required': 'DB_NAME is required â€“ set the PostgreSQL database name.',
  }),
  DB_READ_HOST: Joi.string().optional(),
  DB_READ_PORT: Joi.number().port().optional(),
  TYPEORM_SYNCHRONIZE: Joi.string()
    .valid('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')
    .optional(),
  TYPEORM_ALLOW_PRODUCTION_SYNCHRONIZE: Joi.string()
    .valid('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')
    .optional(),
  TYPEORM_MIGRATIONS_RUN: Joi.string()
    .valid('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')
    .optional(),
  TYPEORM_BASELINE_EXISTING_SCHEMA: Joi.string()
    .valid('true', 'false', '1', '0', 'yes', 'no', 'on', 'off')
    .optional(),
  ADMIN_ACTION_APPROVAL_TTL_MINUTES: Joi.number()
    .integer()
    .min(5)
    .max(1440)
    .default(30),

  // ---- Auth ----
  JWT_SECRET: Joi.string().min(32).required().messages({
    'any.required':
      'JWT_SECRET is required - generate a strong random string (e.g. `openssl rand -base64 48`).',
    'string.min':
      'JWT_SECRET must be at least 32 characters long for production-strength signing.',
  }),
  STEP_UP_PROOF_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(900)
    .default(300),

  // ---- App / URLs ----
  APP_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: Joi.valid('production', 'staging'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .messages({
      'any.required':
        'APP_SECRET is required in production and staging - generate a strong random string (e.g. `openssl rand -base64 48`).',
      'string.min':
        'APP_SECRET must be at least 32 characters long for production-strength security.',
    }),
  BACKEND_URL: Joi.string().uri().optional(),
  FRONTEND_URL: Joi.string().default('http://localhost:3000'),
  OUTBOUND_ALLOWED_ORIGINS: Joi.string()
    .allow('')
    .custom((value, helpers) => {
      if (!value) return value;
      const origins = value.split(',').map((origin: string) => origin.trim());
      const valid = origins.every((origin: string) => {
        try {
          const parsed = new URL(origin);
          return parsed.protocol === 'https:' && parsed.origin === origin;
        } catch {
          return false;
        }
      });
      return valid ? value : helpers.error('string.outboundOrigins');
    })
    .messages({
      'string.outboundOrigins':
        'OUTBOUND_ALLOWED_ORIGINS must be a comma-separated list of exact HTTPS origins without paths.',
    })
    .optional(),

  // â”€â”€ Encryption â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  CONFESSION_ENCRYPTION_KEY: productionHexKey.required().messages({
    'string.length':
      'CONFESSION_ENCRYPTION_KEY must be exactly 64 characters (32-byte hex).',
    'string.hex':
      'CONFESSION_ENCRYPTION_KEY must be a valid hexadecimal string.',
    'any.invalid':
      'CONFESSION_ENCRYPTION_KEY cannot be the all-zero development placeholder.',
    'any.required':
      'CONFESSION_ENCRYPTION_KEY is required for confession security.',
  }),
  ENCRYPTION_CURRENT_KEY_VERSION: Joi.string()
    .pattern(/^v\d+$/)
    .default('v1')
    .messages({
      'string.pattern.base':
        'ENCRYPTION_CURRENT_KEY_VERSION must look like v1, v2, etc.',
    }),
  ENCRYPTION_MASTER_KEY_v1: productionHexKey.required().messages({
    'string.length':
      'ENCRYPTION_MASTER_KEY_v1 must be exactly 64 characters (32-byte hex).',
    'string.hex': 'ENCRYPTION_MASTER_KEY_v1 must be a valid hexadecimal string.',
    'any.invalid':
      'ENCRYPTION_MASTER_KEY_v1 cannot be the all-zero development placeholder.',
    'any.required':
      'ENCRYPTION_MASTER_KEY_v1 is required for envelope encryption.',
  }),

  // â”€â”€ Stellar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  STELLAR_FEATURES_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),
  STELLAR_NETWORK: Joi.string()
    .valid(...STELLAR_NETWORKS)
    .default('testnet'),
  STELLAR_HORIZON_URL: Joi.string()
    .uri()
    .default('https://horizon-testnet.stellar.org')
    .when('STELLAR_NETWORK', {
      is: 'mainnet',
      then: Joi.string()
        .uri()
        .custom((value, helpers) => {
          if (isTestnetEndpoint(value)) {
            return helpers.error('stellar.network.endpointMismatch', {
              field: 'STELLAR_HORIZON_URL',
              network: 'mainnet',
            });
          }
          return value;
        }),
      otherwise: Joi.string()
        .uri()
        .custom((value, helpers) => {
          if (isMainnetEndpoint(value)) {
            return helpers.error('stellar.network.endpointMismatch', {
              field: 'STELLAR_HORIZON_URL',
              network: 'testnet',
            });
          }
          return value;
        }),
    })
    .messages({
      'stellar.network.endpointMismatch':
        '{{#field}} points at a {{#network}}-incompatible endpoint; STELLAR_NETWORK and endpoints must agree.',
    }),
  STELLAR_SOROBAN_RPC_URL: Joi.string()
    .uri()
    .default('https://soroban-rpc-testnet.stellar.org'),
  // Comma-separated ordered list of Soroban RPC endpoints used for failover.
  // The first entry is preferred; STELLAR_SOROBAN_RPC_URL is used when unset.
  STELLAR_SOROBAN_RPC_URLS: Joi.string()
    .allow('')
    .pattern(/^https?:\/\/[^\s,]+(,https?:\/\/[^\s,]+)*$/)
    .optional()
    .messages({
      'string.pattern.base':
        'STELLAR_SOROBAN_RPC_URLS must be a comma-separated list of http(s) URLs.',
    }),
  // How long an endpoint stays in cooldown after a failure before it is probed again.
  STELLAR_RPC_COOLDOWN_MS: Joi.number().min(100).default(30000),
  // Per-request timeout applied to each RPC call before the endpoint is marked unhealthy.
  STELLAR_RPC_REQUEST_TIMEOUT_MS: Joi.number().min(100).default(10000),
  // Consecutive failures required before an endpoint is taken out of rotation.
  STELLAR_RPC_FAILURE_THRESHOLD: Joi.number().min(1).default(3),
  // Consecutive successes required before a recovering endpoint is trusted again.
  STELLAR_RPC_RECOVERY_SUCCESS_THRESHOLD: Joi.number().min(1).default(2),
  // Interval for background health probes of cooling-down endpoints.
  STELLAR_RPC_HEALTH_PROBE_INTERVAL_MS: Joi.number().min(100).default(15000),
  // Maximum number of failover attempts per RPC operation (bounded recovery).
  STELLAR_RPC_MAX_FAILOVER_ATTEMPTS: Joi.number().min(1).max(10).default(3),
  // Backoff between failover attempts.
  STELLAR_RPC_RETRY_BACKOFF_MS: Joi.number().min(0).default(250),
  // Whether submit operations may fail over to another endpoint (read-only ops always may).
  STELLAR_RPC_SUBMIT_FAILOVER_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('true'),
  // Lease TTL for the account-scoped sequence coordinator.
  STELLAR_SEQUENCE_LEASE_TTL_MS: Joi.number().min(1000).default(30000),
  // Max time to wait for a sequence lease before failing the submission.
  STELLAR_SEQUENCE_LEASE_WAIT_MS: Joi.number().min(0).default(15000),
  DEPLOYMENT_METADATA_PATH: Joi.string().optional(),
  // Declares the network the contract IDs below were deployed to. Required
  // whenever Stellar features are enabled so IDs cannot silently cross
  // networks.
  STELLAR_CONTRACT_NETWORK: Joi.string()
    .valid(...STELLAR_NETWORKS)
    .when('STELLAR_FEATURES_ENABLED', {
      is: 'true',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .custom((value, helpers) => {
      const { STELLAR_NETWORK } = helpers.state.ancestors[0] ?? {};
      if (contractNetworkMismatch(value, STELLAR_NETWORK)) {
        return helpers.error('stellar.network.contractMismatch', {
          declared: value,
          network: STELLAR_NETWORK,
        });
      }
      return value;
    })
    .messages({
      'any.required':
        'STELLAR_CONTRACT_NETWORK is required when Stellar features are enabled - declare the network the contract IDs belong to.',
      'any.only':
        'STELLAR_CONTRACT_NETWORK must be one of: testnet, mainnet.',
      'stellar.network.contractMismatch':
        'STELLAR_CONTRACT_NETWORK ({{#declared}}) does not match STELLAR_NETWORK ({{#network}}); contract IDs must belong to the active network.',
    }),
  CONFESSION_ANCHOR_CONTRACT_ID: Joi.string().when(
    'STELLAR_FEATURES_ENABLED',
    {
      is: 'true',
      then: Joi.required(),
      otherwise: Joi.optional(),
    },
  ),
  REPUTATION_BADGES_CONTRACT_ID: Joi.string().when(
    'STELLAR_FEATURES_ENABLED',
    {
      is: 'true',
      then: Joi.required(),
      otherwise: Joi.optional(),
    },
  ),
  TIPPING_SYSTEM_CONTRACT_ID: Joi.string().when('STELLAR_FEATURES_ENABLED', {
    is: 'true',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  STELLAR_SERVER_SECRET: Joi.string()
    .pattern(/^S[A-Z2-7]{55}$/)
    .when('STELLAR_FEATURES_ENABLED', {
      is: 'true',
      then: Joi.when('NODE_ENV', {
        is: productionLike,
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
      otherwise: Joi.optional(),
    })
    .custom((value, helpers) => {
      const ancestors = helpers.state.ancestors[0] ?? {};
      const { NODE_ENV, STELLAR_NETWORK } = ancestors;
      const productionDeployment =
        NODE_ENV === 'production' || NODE_ENV === 'staging';
      // A production/staging deployment must never hold a testnet signer.
      if (productionDeployment && STELLAR_NETWORK === 'testnet') {
        return helpers.error('stellar.network.signerMismatch', {
          reason: 'production deployment configured with STELLAR_NETWORK=testnet',
        });
      }
      return value;
    })
    .messages({
      'string.pattern.base':
        'STELLAR_SERVER_SECRET must be a valid Stellar secret seed starting with S.',
      'any.required':
        'STELLAR_SERVER_SECRET is required when Stellar features are enabled in production.',
      'stellar.network.signerMismatch':
        'STELLAR_SERVER_SECRET cannot be used in a production/staging deployment: {{#reason}}. Use a mainnet signer or disable Stellar features.',
    }),

  // â”€â”€ Tipping SLA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  TIP_VERIFICATION_STALE_THRESHOLD_MINUTES: Joi.number().min(1).default(30),

  // â”€â”€ Stellar finality / confirmation tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Number of ledgers a transaction must be buried under before it is
  // considered final. Stellar closes a ledger roughly every 5 seconds.
  STELLAR_CONFIRMATION_DEPTH: Joi.number().integer().min(1).max(100).default(1),
  // How often the finality tracker polls the RPC/Horizon for new ledgers.
  STELLAR_FINALITY_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(5000),
  // Observations older than this are treated as stale and never promoted to
  // a verified final state.
  STELLAR_FINALITY_MAX_AGE_MS: Joi.number()
    .integer()
    .min(60000)
    .max(86400000)
    .default(3600000),

  // â”€â”€ Stellar multi-contract reconciliation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  STELLAR_RECONCILIATION_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('true'),
  // Interval between reconciliation sweeps for partially completed flows.
  STELLAR_RECONCILIATION_INTERVAL_MS: Joi.number()
    .integer()
    .min(10000)
    .max(3600000)
    .default(60000),
  // Maximum number of partial operations reconciled per sweep.
  STELLAR_RECONCILIATION_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(50),
  // A partial operation older than this is escalated instead of retried.
  STELLAR_RECONCILIATION_MAX_AGE_MS: Joi.number()
    .integer()
    .min(60000)
    .max(604800000)
    .default(86400000),
  // Bounded retry budget for compensating calls.
  STELLAR_RECONCILIATION_MAX_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(20)
    .default(5),
  // Base backoff between compensation attempts (exponential).
  STELLAR_RECONCILIATION_RETRY_BACKOFF_MS: Joi.number()
    .integer()
    .min(100)
    .max(300000)
    .default(2000),

  // â”€â”€ Email (primary) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  MAIL_HOST: Joi.string().default('smtp.ethereal.email'),
  MAIL_PORT: Joi.number().port().default(587),
  MAIL_SECURE: Joi.string().valid('true', 'false').default('false'),
  MAIL_USER: Joi.string().allow('').default(''),
  MAIL_PASSWORD: Joi.string().allow('').default(''),
  MAIL_FROM: Joi.string().default('noreply@xconfess.app'),
  MAIL_TEST_USER: Joi.string().optional(),
  MAIL_TEST_PASS: Joi.string().optional(),

  // â”€â”€ Email (fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  MAIL_FALLBACK_HOST: Joi.string().optional(),
  MAIL_FALLBACK_PORT: Joi.number().port().default(587),
  MAIL_FALLBACK_SECURE: Joi.string().valid('true', 'false').default('false'),
  MAIL_FALLBACK_USER: Joi.string().allow('').optional(),
  MAIL_FALLBACK_PASSWORD: Joi.string().allow('').optional(),
  MAIL_FALLBACK_FROM: Joi.string().optional(),

  // â”€â”€ Email templates / SLO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  EMAIL_WELCOME_CANARY_WEIGHT: Joi.number().min(0).max(100).default(0),
  EMAIL_ROLLOUT_KILLSWITCH: Joi.string()
    .valid('true', 'false')
    .default('false'),
  EMAIL_TEMPLATE_SLO_WINDOW_MINUTES: Joi.number().default(15),
  EMAIL_TEMPLATE_SLO_ACTIVE_MAX_ERROR_RATE_PERCENT: Joi.number().default(5),
  EMAIL_TEMPLATE_SLO_ACTIVE_MAX_P95_LATENCY_MS: Joi.number().default(1200),
  EMAIL_TEMPLATE_SLO_ACTIVE_MIN_SAMPLE_SIZE: Joi.number().default(20),
  EMAIL_TEMPLATE_SLO_ACTIVE_ALERT_AFTER_BREACHES: Joi.number().default(2),
  EMAIL_TEMPLATE_SLO_CANARY_MAX_ERROR_RATE_PERCENT: Joi.number().default(2),
  EMAIL_TEMPLATE_SLO_CANARY_MAX_P95_LATENCY_MS: Joi.number().default(900),
  EMAIL_TEMPLATE_SLO_CANARY_MIN_SAMPLE_SIZE: Joi.number().default(10),
  EMAIL_TEMPLATE_SLO_CANARY_ALERT_AFTER_BREACHES: Joi.number().default(1),

  // â”€â”€ Circuit breaker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  CB_FAILURE_THRESHOLD: Joi.number().default(3),
  CB_COOLDOWN_SECONDS: Joi.number().default(60),
  CB_PROBE_SUCCESS_THRESHOLD: Joi.number().default(2),

  // â”€â”€ Throttle / Rate limit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  THROTTLE_TTL: Joi.number().default(900),
  THROTTLE_LIMIT: Joi.number().default(100),
  RATE_LIMIT_POST_MAX: Joi.number().default(5),
  RATE_LIMIT_POST_WINDOW: Joi.number().default(60),
  RATE_LIMIT_GET_MAX: Joi.number().default(50),
  RATE_LIMIT_GET_WINDOW: Joi.number().default(60),
  NOTIFICATION_DEDUPE_TTL_SECONDS: Joi.number().default(60),
  ANALYTICS_ENABLED: Joi.string().valid('true', 'false').default('true'),
  ANALYTICS_RETENTION_DAYS: Joi.number().min(1).default(365),
  TRACTION_CACHE_TTL_SECONDS: Joi.number().min(1).max(3600).default(60),
  TRACTION_EXCLUDED_USER_IDS: Joi.string()
    .allow('')
    .pattern(/^\d+(,\d+)*$/)
    .default(''),
  TRACTION_EXCLUDED_ANONYMOUS_USER_IDS: Joi.string()
    .allow('')
    .pattern(/^[A-Za-z0-9:_-]+(,[A-Za-z0-9:_-]+)*$/)
    .default(''),
  TRACTION_EXCLUDED_ACTOR_IDS: Joi.string()
    .allow('')
    .pattern(/^[A-Za-z0-9:_-]+(,[A-Za-z0-9:_-]+)*$/)
    .default(''),

  // â”€â”€ DLQ retention â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  DLQ_RETENTION_DAYS: Joi.number().default(14),
  DLQ_CLEANUP_BATCH_SIZE: Joi.number().default(100),
  DLQ_CLEANUP_DRY_RUN: Joi.string().valid('true', 'false').default('false'),

  // -- Export retention cleanup --
  EXPORT_RETENTION_DAYS: Joi.number().min(1).default(7),
  EXPORT_AUDIT_CLEANUP_ACTIONS: Joi.string().valid('true', 'false').default('true'),
  EXPORT_CLEANUP_DRY_RUN: Joi.string().valid('true', 'false').default('false'),

  // â”€â”€ DLQ automatic replay (optional) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  DLQ_AUTO_REPLAY_ENABLED: Joi.string().valid('true', 'false').default('false'),
  DLQ_AUTO_REPLAY_INTERVAL_MS: Joi.number().default(1800000), // 30 min
  DLQ_AUTO_REPLAY_LOOKBACK_MINUTES: Joi.number().default(15),
  DLQ_AUTO_REPLAY_MAX_JOBS_PER_RUN: Joi.number().default(50),

  // â”€â”€ Redis queue health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  REDIS_QUEUE_LATENCY_THRESHOLD_MS: Joi.number().default(250),
  REDIS_QUEUE_WAIT_THRESHOLD_MS: Joi.number().integer().min(1).default(30000),
  NOTIFICATION_WORKER_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(5),
  EXPORT_WORKER_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(1),
  CONFESSION_DRAFT_WORKER_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(1),

  // â”€â”€ Soroban event range verifier (read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  SOROBAN_EVENT_VERIFIER_ENABLED: Joi.string()
    .valid('true', 'false')
    .default('false'),
  SOROBAN_EVENT_VERIFIER_MAX_RANGE: Joi.number()
    .integer()
    .min(1)
    .max(10000)
    .default(1000)
    .messages({
      'number.min':
        'SOROBAN_EVENT_VERIFIER_MAX_RANGE must be at least 1 ledger.',
      'number.max':
        'SOROBAN_EVENT_VERIFIER_MAX_RANGE must not exceed 10000 ledgers per verification pass.',
    }),
  SOROBAN_EVENT_REPROCESS_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(100)
    .messages({
      'number.min':
        'SOROBAN_EVENT_REPROCESS_BATCH_SIZE must be at least 1.',
      'number.max':
        'SOROBAN_EVENT_REPROCESS_BATCH_SIZE must not exceed 1000 events per batch.',
    }),
  // â”€â”€ Transaction latency / failure budgets (per network + operation class) â”€â”€
  TX_BUDGET_ENABLED: Joi.string().valid('true', 'false').default('true'),
  TX_BUDGET_WINDOW_SECONDS: Joi.number().min(10).max(86400).default(300),
  TX_BUDGET_MIN_SAMPLES: Joi.number().min(1).default(5),
  TX_BUDGET_ALERT_AFTER_BREACHES: Joi.number().min(1).default(2),
  // Submission latency (ms) budgets, keyed by network.
  TX_BUDGET_TESTNET_SUBMIT_P95_MS: Joi.number().min(1).default(4000),
  TX_BUDGET_TESTNET_INCLUSION_P95_MS: Joi.number().min(1).default(15000),
  TX_BUDGET_TESTNET_CONFIRMATION_P95_MS: Joi.number().min(1).default(30000),
  TX_BUDGET_MAINNET_SUBMIT_P95_MS: Joi.number().min(1).default(2500),
  TX_BUDGET_MAINNET_INCLUSION_P95_MS: Joi.number().min(1).default(10000),
  TX_BUDGET_MAINNET_CONFIRMATION_P95_MS: Joi.number().min(1).default(20000),
  // Failure-rate budgets (percent) keyed by network.
  TX_BUDGET_TESTNET_MAX_FAILURE_RATE_PERCENT: Joi.number()
    .min(0)
    .max(100)
    .default(10),
  TX_BUDGET_MAINNET_MAX_FAILURE_RATE_PERCENT: Joi.number()
    .min(0)
    .max(100)
    .default(5),

  // â”€â”€ Deployment configuration drift detection (Render vs Vercel) â”€â”€â”€â”€â”€â”€â”€
  CONFIG_DRIFT_CHECK_ENABLED: Joi.string().valid('true', 'false').default('true'),
  CONFIG_DRIFT_CONTRACT_PATH: Joi.string().optional(),
  CONFIG_DRIFT_RENDER_ENV_PATH: Joi.string().optional(),
  CONFIG_DRIFT_VERCEL_ENV_PATH: Joi.string().optional(),
  CONFIG_DRIFT_FAIL_READINESS: Joi.string().valid('true', 'false').default('true'),
  CONFIG_DRIFT_ALLOWED_ORIGIN_MISMATCH: Joi.string()
    .valid('true', 'false')
    .default('false'),

  // â”€â”€ Synthetic transaction checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  SYNTHETIC_TX_CHECKS_ENABLED: Joi.string().valid('true', 'false').default('false'),
  SYNTHETIC_TX_CHECK_INTERVAL_MS: Joi.number().min(1000).default(60000),
  SYNTHETIC_TX_CHECK_TIMEOUT_MS: Joi.number().min(1000).default(45000),
  SYNTHETIC_TX_CHECK_NETWORKS: Joi.string()
    .pattern(/^(testnet|mainnet)(,(testnet|mainnet))*$/)
    .default('testnet'),

  // ── Cross-domain integrity checks ──────────────────────────────────────────
  INTEGRITY_CHECK_DEFAULT_TIMEOUT_MS: Joi.number().min(100).max(30000).default(5000),
  INTEGRITY_CHECK_MAX_TIMEOUT_MS: Joi.number().min(100).max(60000).default(30000),
  INTEGRITY_CHECK_DEFAULT_LIMIT: Joi.number().min(1).max(200).default(50),
  INTEGRITY_CHECK_MAX_LIMIT: Joi.number().min(1).max(1000).default(200),

  // ── Bounded statement timeouts for high-cost database operations (#185) ─────
  DB_STATEMENT_TIMEOUT_MS: Joi.number()
    .min(100)
    .max(60000)
    .default(5000)
    .messages({
      'number.max':
        'DB_STATEMENT_TIMEOUT_MS must not exceed 60000 ms (1 minute).',
    }),
  DB_STATEMENT_TIMEOUT_MAX_MS: Joi.number()
    .min(100)
    .max(120000)
    .default(30000)
    .messages({
      'number.max':
        'DB_STATEMENT_TIMEOUT_MAX_MS must not exceed 120000 ms (2 minutes).',
    }),

  // ── Route-specific request/response size budgets (#181) ────────────────────
  REQUEST_DEFAULT_MAX_BYTES: Joi.number()
    .min(1024)
    .max(1048576)
    .default(102400)
    .messages({
      'number.max':
        'REQUEST_DEFAULT_MAX_BYTES must not exceed 1048576 bytes (1 MiB).',
    }),
  REQUEST_SIZE_LIMITS: Joi.string()
    .allow('')
    .pattern(/^\s*\{.*\}\s*$/, {
      name: 'requestSizeLimits',
      description:
        'REQUEST_SIZE_LIMITS must be a JSON object of budget name -> bytes.',
    })
    .optional(),
  REQUEST_MAX_NESTING_DEPTH: Joi.number()
    .min(1)
    .max(32)
    .default(8)
    .messages({
      'number.max':
        'REQUEST_MAX_NESTING_DEPTH must not exceed 32 levels of nesting.',
    }),
}).options({ allowUnknown: true, abortEarly: false });
