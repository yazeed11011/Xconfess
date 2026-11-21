import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfessionSchedulerService } from './confession-scheduler.service';
import { AnonymousConfession } from './entities/confession.entity';
import { CLOCK, Clock } from '../common/clock';

describe('ConfessionSchedulerService', () => {
  let service: ConfessionSchedulerService;
  let repo: jest.Mocked<Repository<AnonymousConfession>>;
  let queryBuilder: any;
  let updateBuilder: any;
  let fixedNow: Date;
  let clock: Clock;

  beforeEach(async () => {
    fixedNow = new Date('2026-09-24T10:00:00.000Z');
    clock = { now: jest.fn(() => new Date(fixedNow)) };
    queryBuilder = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    repo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
    } as any;

    // First createQueryBuilder call = select, second = update
    repo.createQueryBuilder
      .mockReturnValueOnce(queryBuilder)
      .mockReturnValue(updateBuilder);

    const mockDataSource = {
      transaction: jest.fn(async (cb: any) =>
        cb({ getRepository: () => repo }),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfessionSchedulerService,
        {
          provide: getRepositoryToken(AnonymousConfession),
          useValue: repo,
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: CLOCK, useValue: clock },
      ],
    }).compile();

    service = module.get<ConfessionSchedulerService>(
      ConfessionSchedulerService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('publishScheduledConfessions', () => {
    it('publishes scheduled confessions whose publishAt has passed', async () => {
      const scheduled = [
        {
          id: 'conf-1',
          status: 'scheduled',
          publishAt: new Date('2025-01-01'),
        },
      ] as AnonymousConfession[];

      queryBuilder.getMany.mockResolvedValue(scheduled);
      updateBuilder.execute.mockResolvedValue({ affected: 1 });

      await service.publishScheduledConfessions();

      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: 'published',
        created_at: expect.any(Date),
      });
      expect(updateBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 'conf-1',
      });
      expect(updateBuilder.andWhere).toHaveBeenCalledWith(
        'status = :status',
        { status: 'scheduled' },
      );
    });

    it('uses the controlled instant for due selection and publication timestamps', async () => {
      queryBuilder.getMany.mockResolvedValue([
        {
          id: 'conf-deterministic',
          status: 'scheduled',
          publishAt: new Date('2026-09-24T09:59:00.000Z'),
        },
      ] as AnonymousConfession[]);
      updateBuilder.execute.mockResolvedValue({ affected: 1 });

      await service.publishScheduledConfessions();

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'confession.publishAt <= :now',
        { now: fixedNow },
      );
      expect(updateBuilder.set).toHaveBeenCalledWith({
        status: 'published',
        created_at: fixedNow,
      });
    });

    it('skips confessions already published by a concurrent run (affected: 0)', async () => {
      const scheduled = [
        {
          id: 'conf-1',
          status: 'scheduled',
          publishAt: new Date('2025-01-01'),
        },
      ] as AnonymousConfession[];

      queryBuilder.getMany.mockResolvedValue(scheduled);
      updateBuilder.execute.mockResolvedValue({ affected: 0 });

      await service.publishScheduledConfessions();

      expect(updateBuilder.execute).toHaveBeenCalled();
    });

    it('continues processing remaining confessions when one publish fails', async () => {
      const scheduled = [
        {
          id: 'conf-1',
          status: 'scheduled',
          publishAt: new Date('2025-01-01'),
        },
        {
          id: 'conf-2',
          status: 'scheduled',
          publishAt: new Date('2025-01-01'),
        },
      ] as AnonymousConfession[];

      queryBuilder.getMany.mockResolvedValue(scheduled);

      // First update throws, second succeeds
      updateBuilder.execute
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ affected: 1 });

      await service.publishScheduledConfessions();

      expect(updateBuilder.execute).toHaveBeenCalledTimes(2);
    });

    it('acquires pessimistic write lock on scheduled confessions', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.publishScheduledConfessions();

      expect(queryBuilder.setLock).toHaveBeenCalledWith('pessimistic_write');
    });

    it('does nothing when no confessions are due', async () => {
      queryBuilder.getMany.mockResolvedValue([]);

      await service.publishScheduledConfessions();

      expect(updateBuilder.execute).not.toHaveBeenCalled();
    });

    it('wraps the entire batch in a transaction', async () => {
      queryBuilder.getMany.mockResolvedValue([]);
      const ds = { transaction: jest.fn() };
      const svc = new ConfessionSchedulerService(repo, ds as any);

      ds.transaction.mockImplementation(async (cb: any) => cb({ getRepository: () => repo }));

      await svc.publishScheduledConfessions();
      expect(ds.transaction).toHaveBeenCalled();
    });
  });

  describe('scheduleConfession', () => {
    it('schedules a confession for future publishing', async () => {
      const futureDate = new Date('2026-09-24T11:00:00.000Z');
      const confession = {
        id: 'conf-1',
        status: 'published',
        publishAt: null,
      } as AnonymousConfession;

      repo.findOne.mockResolvedValue(confession);
      repo.save.mockResolvedValue({
        ...confession,
        status: 'scheduled',
        publishAt: futureDate,
      });

      const result = await service.scheduleConfession('conf-1', futureDate);

      expect(result.status).toBe('scheduled');
      expect(result.publishAt).toEqual(futureDate);
    });

    it('throws when confession is not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.scheduleConfession(
          'missing',
          new Date('2026-09-24T11:00:00.000Z'),
        ),
      ).rejects.toThrow('Confession not found');
    });

    it('throws when publish date is in the past', async () => {
      repo.findOne.mockResolvedValue({
        id: 'conf-1',
        status: 'published',
      } as AnonymousConfession);

      await expect(
        service.scheduleConfession('conf-1', new Date('2020-01-01')),
      ).rejects.toThrow('Publish date must be in the future');
    });

    it('rejects a publish date equal to the injected current instant', async () => {
      repo.findOne.mockResolvedValue({
        id: 'conf-1',
        status: 'published',
      } as AnonymousConfession);

      await expect(
        service.scheduleConfession('conf-1', fixedNow),
      ).rejects.toThrow('Publish date must be in the future');
    });
  });

  describe('cancelSchedule', () => {
    it('reverts a scheduled confession back to draft', async () => {
      const confession = {
        id: 'conf-1',
        status: 'scheduled',
        publishAt: new Date('2026-09-24T11:00:00.000Z'),
      } as AnonymousConfession;

      repo.findOne.mockResolvedValue(confession);
      repo.save.mockResolvedValue({
        ...confession,
        status: 'draft',
        publishAt: null,
      });

      const result = await service.cancelSchedule('conf-1');

      expect(result.status).toBe('draft');
      expect(result.publishAt).toBeNull();
    });

    it('throws when confession is not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.cancelSchedule('missing')).rejects.toThrow(
        'Confession not found',
      );
    });
  });

  describe('getScheduledConfessions', () => {
    it('returns scheduled confessions for a user ordered by publishAt ASC', async () => {
      const confessions = [
        { id: 'c2', publishAt: new Date('2025-02-01') },
        { id: 'c1', publishAt: new Date('2025-01-01') },
      ] as AnonymousConfession[];

      repo.find.mockResolvedValue(confessions);

      const result = await service.getScheduledConfessions('user-1');

      expect(repo.find).toHaveBeenCalledWith({
        where: { anonymousUserId: 'user-1', status: 'scheduled' },
        order: { publishAt: 'ASC' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('reconcileStaleScheduledPublications', () => {
    it('detects overdue scheduled posts and safely resumes eligible work using SKIP LOCKED', async () => {
      queryBuilder.setOnLocked = jest.fn().mockReturnThis();
      const overdueConfessions = [
        { id: 'c-stale-1', status: 'scheduled', publishAt: new Date('2026-09-24T09:50:00.000Z'), isDeleted: false },
      ] as any;

      queryBuilder.getMany.mockResolvedValue(overdueConfessions);
      updateBuilder.execute.mockResolvedValue({ affected: 1 });

      const res = await service.reconcileStaleScheduledPublications({ thresholdMinutes: 5 });

      expect(queryBuilder.setOnLocked).toHaveBeenCalledWith('skip_locked');
      expect(res.attempted).toBe(1);
      expect(res.reconciled).toBe(1);
      expect(res.terminal).toBe(0);
    });

    it('reports terminal status for deleted or corrupted scheduled records', async () => {
      queryBuilder.setOnLocked = jest.fn().mockReturnThis();
      repo.update = jest.fn().mockResolvedValue({ affected: 1 });
      const deletedConfession = [
        { id: 'c-del-1', status: 'scheduled', publishAt: new Date('2026-09-24T09:50:00.000Z'), isDeleted: true },
      ] as any;

      queryBuilder.getMany.mockResolvedValue(deletedConfession);

      const res = await service.reconcileStaleScheduledPublications();

      expect(res.attempted).toBe(1);
      expect(res.terminal).toBe(1);
      expect(repo.update).toHaveBeenCalledWith('c-del-1', { status: 'failed' });
    });
  });
});
