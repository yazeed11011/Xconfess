import { Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { SanitizationMiddleware } from './middleware/sanitization.middleware';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { RequestCancellationMiddleware } from './middleware/request-cancellation.middleware';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getTypeOrmConfig } from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import appConfig from './config/app.config';
import queryTimeoutConfig from './config/query-timeout.config';
import requestSizeConfig from './config/request-size.config';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { CapabilitiesModule } from './auth/capabilities/capabilities.module';
import { ConfessionModule } from './confession/confession.module';
import { ConfessionDraftModule } from './confession-draft/confession-draft.module';
import { SearchDiscoveryModule } from './search-discovery/search-discovery.module';
import { WebhookModule } from './webhooks/webhook.module';
import { ApiDeprecationModule } from './deprecation/api-deprecation.module';
import { TopicModule } from './topic/topic.module';
import { CommentModule } from './comment/comment.module';
import { ReactionModule } from './reaction/reaction.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { CollectionsModule } from './collections/collections.module';
import { BulkReadModule } from './bulk-reads/bulk-read.module';
import { ContentTypeLimitsMiddleware } from './middleware/content-type-limits.middleware';
import { LocaleNegotiatorService } from './i18n-errors/locale-negotiator.service';
import { I18nExceptionFilter } from './i18n-errors/i18n-exception.filter';
import throttleConfig from './config/throttle.config';
import exportConfig from './config/export.config';
import integrityConfig from './config/integrity.config';
import { HealthModule } from './health/health.module';
import { MessagesModule } from './messages/messages.module';
import { AdminModule } from './admin/admin.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ReportModule } from './report/report.module';
import { AppealModule } from './appeal/appeal.module';
import { DataExportModule } from './data-export/data-export.module';
import { StellarModule } from './stellar/stellar.module';
import { CacheModule } from './cache/cache.module';
import { TippingModule } from './tipping/tipping.module';
import { LoggerModule } from './logger/logger.module';
import { ScheduleModule } from '@nestjs/schedule';
import { EncryptionModule } from './encryption/encryption.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DatabaseModule } from './database/database.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { BookmarkModule } from './bookmark/bookmark.module';
import { KeyRotationModule } from './key-rotation/key-rotation.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MediaModule } from './media/media.module';
// ➩ Canonical queue stack: @nestjs/bullmq (BullMQ v4 + ioredis)
// The legacy @nestjs/bull import has been removed. All queues use BullMQ.
import { BullModule } from '@nestjs/bullmq';
import { StructuredLoggingInterceptor } from './common/logging/structured-logging.interceptor';
import { PerformanceInterceptor } from './common/interceptors/performance.interceptor';
import { HttpCacheInterceptor } from './common/interceptors/http-cache.interceptor';
import { ResponseSizeInterceptor } from './common/interceptors/response-size.interceptor';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { OpsModule } from './ops/ops.module';
import { TestingFixturesModule } from './testing-fixtures/testing-fixtures.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [
        throttleConfig,
        appConfig,
        exportConfig,
        integrityConfig,
        queryTimeoutConfig,
        requestSizeConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    CSRFModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('throttle.ttl') || 60_000,
            limit: config.get<number>('throttle.limit') || 60,
          },
          {
            name: 'strict',
            ttl: (config.get<number>('throttle.strictTtlSeconds') || 60) * 1000,
            limit: config.get<number>('throttle.strictLimit') || 5,
          },
        ],
      }),
    }),
    /**
     * BullMQ global connection config.
     *
     * A single ioredis connection object is shared across all queues via
     * BullModule.forRootAsync().  Individual queue modules call
     * BullModule.registerQueue({ name: '...' }) — they do NOT pass their own
     * connection.
     *
     * Retry semantics (defaultJobOptions) are set here so every queue inherits
     * them consistently.  Override per-queue only when there is a documented
     * reason.
     */
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisHost = config.get<string>('REDIS_HOST');
        const redisPort = config.get<number>('REDIS_PORT');
        const jobsEnabled =
          config.get<string>('ENABLE_BACKGROUND_JOBS') === 'true';

        if (jobsEnabled) {
          if (!redisHost || !redisPort) {
            throw new Error(
              'Misconfiguration: ENABLE_BACKGROUND_JOBS is true but ' +
                'REDIS_HOST or REDIS_PORT is missing from the environment.',
            );
          }
        } else {
          new Logger('Bootstrap').warn(
            'ENABLE_BACKGROUND_JOBS is not "true" — BullMQ workers are disabled. ' +
              'Queue producers will silently skip enqueue calls. Redis connectivity is not required.',
          );
        }

        return {
          connection: {
            host: redisHost || 'localhost',
            port: redisPort || 6379,
          },
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 5_000, // 5 s → 10 s → 20 s
            },
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
          },
        };
      },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: getTypeOrmConfig,
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    RateLimitModule,
    OpsModule,
    TestingFixturesModule,
    HealthModule,
    AnalyticsModule,
    MediaModule,
    UserModule,
    AuthModule,
    CapabilitiesModule,
    AccountMergeModule,
    ConfessionModule,
    ConfessionDraftModule,
    SearchDiscoveryModule,
    WebhookModule,
    ApiDeprecationModule,
    TopicModule,
    ReactionModule,
    CommentModule,
    MessagesModule,
    AdminModule,
    ReportModule,
    AppealModule,
    DataExportModule,
    NotificationsModule,
    StellarModule,
    TippingModule,
    LoggerModule,
    EncryptionModule,
    CacheModule,
    DatabaseModule,
    FeatureFlagsModule,
    BookmarkModule,
    KeyRotationModule,
    SecurityModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Issue: layered, abuse-resistant rate limiting by anonymous identity,
    // account, IP reputation, route cost, and trusted admin bypasses.
    // Replaces the IP-only ThrottlerGuard as the global guard.
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: StructuredLoggingInterceptor,
    },
    // Issue #101: latency budget enforcement and p50/p95/p99 tracking.
    {
      provide: APP_INTERCEPTOR,
      useClass: PerformanceInterceptor,
    },
    // Issue #103: HTTP cache headers, ETags, and 304 conditional responses.
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpCacheInterceptor,
    },
    // Issue #181: response-size instrumentation and per-route response budgets.
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseSizeInterceptor,
    },
    LocaleNegotiatorService,
    {
      provide: APP_FILTER,
      useClass: I18nExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // SecurityHeadersMiddleware first so every response (including error
    // responses) carries the CSP and baseline security headers.
    // RequestIdMiddleware next so downstream handlers/loggers can read
    // req.requestId, and so it's set even if SanitizationMiddleware throws.
    // CSRFMiddleware applies to every route and enforces double-submit
    // tokens on cookie-authenticated mutations.
    consumer.apply(
      RequestIdMiddleware,
      RequestCancellationMiddleware,
      ContentTypeLimitsMiddleware,
      SanitizationMiddleware,
      CSRFMiddleware,
    ).forRoutes('*');
  }
}
