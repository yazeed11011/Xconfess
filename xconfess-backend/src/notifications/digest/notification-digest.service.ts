import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotificationDigestRecord,
  DigestStatus,
} from './entities/notification-digest-record.entity';
import { User } from '../../user/entities/user.entity';

export interface RawDigestEvent {
  id: string;
  type: string;
  title: string;
  message?: string;
  confessionId?: string;
  isDeleted?: boolean;
  moderationStatus?: string;
  actorIdentifier?: string;
  createdAt: Date | string;
}

export interface GenerateDigestOptions {
  windowStart: Date;
  windowEnd: Date;
  events: RawDigestEvent[];
  userTimezone?: string;
}

@Injectable()
export class NotificationDigestService {
  private readonly logger = new Logger(NotificationDigestService.name);

  constructor(
    @InjectRepository(NotificationDigestRecord)
    private readonly digestRepo: Repository<NotificationDigestRecord>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  generateDigestKey(userId: number, windowStart: Date, windowEnd: Date): string {
    const startStr = windowStart.toISOString().slice(0, 10);
    const endStr = windowEnd.toISOString().slice(0, 10);
    return `digest:${userId}:${startStr}:${endStr}`;
  }

  isQuietHours(date: Date, timezone = 'UTC'): boolean {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
      });
      const hour = parseInt(formatter.format(date), 10);
      // Quiet hours defined as 22:00 (10 PM) to 08:00 (8 AM)
      return hour >= 22 || hour < 8;
    } catch {
      const hour = date.getUTCHours();
      return hour >= 22 || hour < 8;
    }
  }

  redactEvent(event: RawDigestEvent): Record<string, any> {
    const previewMessage = event.message
      ? event.message.slice(0, 60) + (event.message.length > 60 ? '...' : '')
      : undefined;

    return {
      id: event.id,
      type: event.type,
      title: event.title,
      preview: previewMessage,
      confessionId: event.confessionId,
      // Strictly redact actor email/ID - only anonymous reference
      actor: event.actorIdentifier ? 'Anonymous Member' : undefined,
      createdAt: event.createdAt,
    };
  }

  async generateUserDigest(
    userId: number,
    options: GenerateDigestOptions,
  ): Promise<NotificationDigestRecord> {
    const digestKey = this.generateDigestKey(
      userId,
      options.windowStart,
      options.windowEnd,
    );

    // 1. Deduplication across worker retries
    const existing = await this.digestRepo.findOne({ where: { digestKey } });
    if (existing) {
      this.logger.debug(
        `Deduplicating notification digest ${digestKey}; already exists with status ${existing.status}`,
      );
      return existing;
    }

    // 2. Privacy preferences check
    const user = await this.userRepo.findOne({ where: { id: userId } });
    const privacy = (user as any)?.privacy_settings || {};

    if (privacy.enableEmailDigests === false) {
      const suppressedRecord = this.digestRepo.create({
        userId,
        digestKey,
        windowStart: options.windowStart,
        windowEnd: options.windowEnd,
        totalEvents: options.events.length,
        includedEvents: [],
        status: DigestStatus.SUPPRESSED_PRIVACY,
      });
      return this.digestRepo.save(suppressedRecord);
    }

    // 3. Quiet hours check
    const now = new Date();
    const quiet = this.isQuietHours(now, options.userTimezone || 'UTC');

    // 4. Per-event redaction and filtering
    const eligibleEvents = options.events.filter(
      (e) => !e.isDeleted && e.moderationStatus !== 'rejected',
    );

    const redactedEvents = eligibleEvents.map((e) => this.redactEvent(e));

    const status = quiet ? DigestStatus.DEFERRED : DigestStatus.DELIVERED;

    const digest = this.digestRepo.create({
      userId,
      digestKey,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      totalEvents: redactedEvents.length,
      includedEvents: redactedEvents,
      status,
      deliveredAt: quiet ? undefined : now,
    });

    return this.digestRepo.save(digest);
  }

  async getLatestDigests(userId: number): Promise<NotificationDigestRecord[]> {
    return this.digestRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
  }
}
