import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { ConfessionDraftService } from './confession-draft.service';
import {
  ConfessionDraft,
  ConfessionDraftStatus,
} from './entities/confession-draft.entity';
import { ConfessionService } from '../confession/confession.service';
import { encryptConfession } from '../utils/confession-encryption';
import { CLOCK, Clock } from '../common/clock';

jest.mock('../confession/confession.service', () => ({
  ConfessionService: class ConfessionService {},
}));

const AES_KEY = '12345678901234567890123456789012';

describe('ConfessionDraftService', () => {
  let service: ConfessionDraftService;
  let repo: jest.Mocked<Repository<ConfessionDraft>>;
  let fixedNow: Date;
  let clock: Clock;

  beforeEach(async () => {
    fixedNow = new Date('2026-09-24T10:00:00.000Z');
    clock = { now: jest.fn(() => new Date(fixedNow)) };
    repo = {
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfessionDraftService,
        { provide: getRepositoryToken(ConfessionDraft), useValue: repo },
        { provide: ConfessionService, useValue: { create: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'app.confessionAesKey') return AES_KEY;
              return null;
            }),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn(async (cb: any) =>
              cb({ getRepository: () => repo }),
            ),
          },
        },
        { provide: CLOCK, useValue: clock },
      ],
    }).compile();

    service = module.get(ConfessionDraftService);
  });

  it('createDraft encrypts content and returns decrypted content', async () => {
    repo.count.mockResolvedValue(0);
    repo.create.mockImplementation((x: any) => x);
    repo.save.mockImplementation(async (x: any) => ({
      ...x,
      id: 'draft1',
      createdAt: fixedNow,
      updatedAt: fixedNow,
      scheduledFor: null,
      timezone: null,
      status: ConfessionDraftStatus.DRAFT,
      publishAttempts: 0,
      lastPublishError: null,
    }));

    const res = await service.createDraft(1, 'hello');
    expect(res.content).toBe('hello');
  });

  it('rejects schedules at the injected current instant', async () => {
    repo.count.mockResolvedValue(0);

    await expect(
      service.createDraft(
        1,
        'not in the future',
        undefined,
        fixedNow.toISOString(),
      ),
    ).rejects.toThrow('scheduledFor must be in the future');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('converts an explicitly zoned future draft time to UTC', async () => {
    repo.count.mockResolvedValue(0);
    repo.create.mockImplementation((input: any) => input);
    repo.save.mockImplementation(async (input: any) => input);

    const result = await service.createDraft(
      1,
      'scheduled',
      undefined,
      '2026-09-24T11:00:00',
      'America/New_York',
    );

    expect(result.scheduledFor.toISOString()).toBe('2026-09-24T15:00:00.000Z');
    expect(result.status).toBe(ConfessionDraftStatus.SCHEDULED);
    expect(result.timezone).toBe('America/New_York');
  });

  it('enforces a 10 draft limit per user', async () => {
    repo.count.mockResolvedValue(10);

    await expect(service.createDraft(1, 'over limit')).rejects.toThrow(
      'Draft limit reached (max 10)',
    );
  });

  describe('updateDraft', () => {
    it('successfully updates and saves revision when version matches', async () => {
      const draft = {
        id: 'draft1',
        userId: 1,
        content: encryptConfession('old content', AES_KEY),
        version: 1,
        revisions: [],
        status: ConfessionDraftStatus.DRAFT,
      } as any;

      repo.findOne.mockResolvedValue(draft);
      repo.save.mockImplementation(async (x: any) => ({
        ...x,
        version: x.version + 1,
      }));

      const res = await service.updateDraft(1, 'draft1', {
        content: 'new content',
        version: 1,
      });

      expect(res.content).toBe('new content');
      expect(res.revisions).toHaveLength(1);
      expect(res.revisions[0].content).toBe('old content');
      expect(res.revisions[0].version).toBe(1);
      expect(res.revisions[0].createdAt).toEqual(fixedNow);
    });

    it('throws ConflictException when version mismatch', async () => {
      const draft = {
        id: 'draft1',
        userId: 1,
        content: encryptConfession('server content', AES_KEY),
        version: 2,
        revisions: [],
        status: ConfessionDraftStatus.DRAFT,
      } as any;

      repo.findOne.mockResolvedValue(draft);

      await expect(
        service.updateDraft(1, 'draft1', {
          content: 'stale client content',
          version: 1,
        }),
      ).rejects.toThrow('Conflict detected');
    });

    it('version-mismatch conflict carries reason, currentVersion and remote content', async () => {
      const draft = {
        id: 'draft1',
        userId: 1,
        content: encryptConfession('server content', AES_KEY),
        version: 2,
        revisions: [],
        status: ConfessionDraftStatus.DRAFT,
      } as any;

      repo.findOne.mockResolvedValue(draft);

      expect.assertions(4);
      try {
        await service.updateDraft(1, 'draft1', {
          content: 'stale client content',
          version: 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const body = (err as ConflictException).getResponse() as any;
        expect(body.reason).toBe('remote_updated');
        expect(body.currentVersion).toBe(2);
        expect(body.currentDraft.content).toBe('server content');
      }
    });

    it('throws a remote_deleted conflict when a versioned update targets a missing draft', async () => {
      repo.findOne.mockResolvedValue(null);

      expect.assertions(3);
      try {
        await service.updateDraft(1, 'gone', {
          content: 'offline edit',
          version: 3,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const body = (err as ConflictException).getResponse() as any;
        expect(body.reason).toBe('remote_deleted');
        expect(body.draftId).toBe('gone');
      }
    });

    it('still throws a plain NotFoundException for an unversioned update to a missing draft', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.updateDraft(1, 'gone', { content: 'no version' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows autosave updates without a version', async () => {
      const draft = {
        id: 'draft1',
        userId: 1,
        content: encryptConfession('old content', AES_KEY),
        version: 2,
        revisions: [],
        status: ConfessionDraftStatus.DRAFT,
      } as any;

      repo.findOne.mockResolvedValue(draft);
      repo.save.mockImplementation(async (x: any) => x);

      const res = await service.autoSaveDraft(1, {
        id: 'draft1',
        content: 'autosaved content',
        category: 'female',
      });

      expect(res.content).toBe('autosaved content');
      expect(res.category).toBe('female');
    });

    it('bounds revision history to 10 entries', async () => {
      const oldRevisions = Array(10)
        .fill(null)
        .map((_, i) => ({
          content: encryptConfession(`rev-${i}`, AES_KEY),
          version: i,
          createdAt: fixedNow,
        }));

      const draft = {
        id: 'draft1',
        userId: 1,
        content: encryptConfession('current', AES_KEY),
        version: 10,
        revisions: [...oldRevisions],
        status: ConfessionDraftStatus.DRAFT,
      } as any;

      repo.findOne.mockResolvedValue(draft);
      repo.save.mockImplementation(async (x: any) => x);

      const res = await service.updateDraft(1, 'draft1', {
        content: 'newest',
        version: 10,
      });

      expect(res.revisions).toHaveLength(10);
      expect(res.revisions[0].content).toBe('current');
      expect(res.revisions[9].content).toBe('rev-8');
    });
  });

  it('rejects rescheduling at the injected current instant', async () => {
    repo.findOne.mockResolvedValue({
      id: 'draft1',
      userId: 1,
      content: encryptConfession('draft', AES_KEY),
      status: ConfessionDraftStatus.DRAFT,
    } as ConfessionDraft);

    await expect(
      service.scheduleDraft(1, 'draft1', fixedNow.toISOString()),
    ).rejects.toThrow('scheduledFor must be in the future');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('uses the injected instant when selecting due drafts', async () => {
    repo.find.mockResolvedValue([]);

    await service.enqueueDueDraftIds();

    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduledFor: expect.objectContaining({ value: fixedNow }),
        }),
      }),
    );
  });
});
