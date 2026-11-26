import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationDigestService } from './notification-digest.service';
import {
  NotificationDigestRecord,
  DigestStatus,
} from './entities/notification-digest-record.entity';
import { User } from '../../user/entities/user.entity';

describe('NotificationDigestService', () => {
  let service: NotificationDigestService;
  let digestRepo: any;
  let userRepo: any;

  beforeEach(async () => {
    digestRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'digest-uuid-1' })),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };

    userRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 1, privacy_settings: { enableEmailDigests: true } }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDigestService,
        { provide: getRepositoryToken(NotificationDigestRecord), useValue: digestRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
      ],
    }).compile();

    service = module.get<NotificationDigestService>(NotificationDigestService);
  });

  it('should deduplicate digest generation across worker retries using digestKey', async () => {
    const existingRecord = {
      id: 'existing-1',
      digestKey: 'digest:1:2026-11-20:2026-11-20',
      status: DigestStatus.DELIVERED,
    };
    digestRepo.findOne.mockResolvedValueOnce(existingRecord);

    const res = await service.generateUserDigest(1, {
      windowStart: new Date('2026-11-20T00:00:00Z'),
      windowEnd: new Date('2026-11-20T23:59:59Z'),
      events: [],
    });

    expect(res).toBe(existingRecord);
    expect(digestRepo.save).not.toHaveBeenCalled();
  });

  it('should respect user privacy settings and suppress email digest when disabled', async () => {
    userRepo.findOne.mockResolvedValueOnce({
      id: 1,
      privacy_settings: { enableEmailDigests: false },
    });

    const res = await service.generateUserDigest(1, {
      windowStart: new Date('2026-11-20T00:00:00Z'),
      windowEnd: new Date('2026-11-20T23:59:59Z'),
      events: [{ id: 'e1', type: 'comment', title: 'New comment', createdAt: new Date() }],
    });

    expect(res.status).toBe(DigestStatus.SUPPRESSED_PRIVACY);
    expect(res.includedEvents).toHaveLength(0);
  });

  it('should redact sensitive confession content and actor identity', () => {
    const raw = {
      id: 'e2',
      type: 'reaction',
      title: 'Reaction added',
      message: 'This is a long secret confession message that contains private details',
      actorIdentifier: 'user@private.com',
      createdAt: new Date(),
    };

    const redacted = service.redactEvent(raw);
    expect(redacted.preview).toContain('...');
    expect(redacted.actor).toBe('Anonymous Member');
    expect(redacted).not.toHaveProperty('actorIdentifier');
  });
});
