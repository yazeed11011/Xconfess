import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MediaThumbnailService } from './media-thumbnail.service';
import {
  MediaThumbnailJob,
  MediaJobStatus,
} from './entities/media-thumbnail-job.entity';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

describe('MediaThumbnailService', () => {
  let service: MediaThumbnailService;
  let jobRepo: any;

  const mockJob: MediaThumbnailJob = {
    id: 'job-uuid-1',
    userId: 10,
    originalFileKey: 'uploads/10/photo.jpg',
    originalMimeType: 'image/jpeg',
    originalSizeBytes: 1024 * 1024,
    targetWidth: 320,
    targetHeight: 320,
    format: 'webp',
    idempotentKey: 'mock-hash-key',
    status: MediaJobStatus.PENDING,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    jobRepo = {
      create: jest.fn().mockImplementation((dto) => ({ ...dto, id: 'job-uuid-1' })),
      save: jest.fn().mockImplementation((j) => Promise.resolve(j)),
      findOne: jest.fn().mockResolvedValue(mockJob),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaThumbnailService,
        {
          provide: getRepositoryToken(MediaThumbnailJob),
          useValue: jobRepo,
        },
      ],
    }).compile();

    service = module.get<MediaThumbnailService>(MediaThumbnailService);
  });

  it('should reject inputs exceeding maximum bound of 15MB', async () => {
    await expect(
      service.enqueueThumbnailJob(
        { id: 10 },
        {
          originalFileKey: 'uploads/10/huge.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 20 * 1024 * 1024,
        },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should return existing job idempotently when key matches', async () => {
    jobRepo.findOne.mockResolvedValueOnce(mockJob);

    const result = await service.enqueueThumbnailJob(
      { id: 10 },
      {
        originalFileKey: 'uploads/10/photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024 * 1024,
      },
    );

    expect(result.id).toBe(mockJob.id);
  });

  it('should enforce safe original-file access rules on third-party users', async () => {
    jobRepo.findOne.mockResolvedValueOnce(mockJob);

    await expect(
      service.getJob('job-uuid-1', { id: 999, role: 'user' }),
    ).rejects.toThrow(ForbiddenException);
  });
});
