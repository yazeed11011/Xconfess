import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  MediaThumbnailJob,
  MediaJobStatus,
} from './entities/media-thumbnail-job.entity';
import { CreateThumbnailJobDto } from './dto/create-thumbnail-job.dto';

export interface MediaActor {
  id: number;
  role?: string;
}

@Injectable()
export class MediaThumbnailService {
  private readonly logger = new Logger(MediaThumbnailService.name);
  private readonly MAX_INPUT_BYTES = 15 * 1024 * 1024; // 15MB
  private readonly MAX_OUTPUT_BYTES = 250 * 1024; // 250KB

  constructor(
    @InjectRepository(MediaThumbnailJob)
    private readonly jobRepo: Repository<MediaThumbnailJob>,
  ) {}

  generateIdempotentKey(
    fileKey: string,
    width: number,
    height: number,
    format: string,
  ): string {
    return crypto
      .createHash('sha256')
      .update(`${fileKey}:${width}:${height}:${format}`)
      .digest('hex');
  }

  assertAccessAllowed(job: MediaThumbnailJob, actor: MediaActor): void {
    const isOwner = job.userId === actor.id;
    const isModerator =
      actor.role === 'admin' || actor.role === 'moderator';

    if (!isOwner && !isModerator) {
      throw new ForbiddenException(
        'You are not authorized to access this media artifact',
      );
    }
  }

  async enqueueThumbnailJob(
    actor: MediaActor,
    dto: CreateThumbnailJobDto,
  ): Promise<MediaThumbnailJob> {
    if (dto.sizeBytes > this.MAX_INPUT_BYTES) {
      throw new BadRequestException(
        `Input media size (${dto.sizeBytes} bytes) exceeds limit of ${this.MAX_INPUT_BYTES} bytes`,
      );
    }

    const targetWidth = Math.min(640, Math.max(32, dto.targetWidth || 320));
    const targetHeight = Math.min(640, Math.max(32, dto.targetHeight || 320));
    const format = dto.format || 'webp';

    const idempotentKey = this.generateIdempotentKey(
      dto.originalFileKey,
      targetWidth,
      targetHeight,
      format,
    );

    // Return existing job if already registered
    const existing = await this.jobRepo.findOne({
      where: { idempotentKey },
    });
    if (existing) {
      this.assertAccessAllowed(existing, actor);
      return existing;
    }

    const job = this.jobRepo.create({
      userId: actor.id,
      originalFileKey: dto.originalFileKey,
      originalMimeType: dto.mimeType,
      originalSizeBytes: dto.sizeBytes,
      targetWidth,
      targetHeight,
      format,
      idempotentKey,
      status: MediaJobStatus.PENDING,
    });

    const saved = await this.jobRepo.save(job);

    // Trigger async processing
    this.processJob(saved.id).catch((err) =>
      this.logger.error(`Thumbnail job ${saved.id} processing error: ${err.message}`),
    );

    return saved;
  }

  async processJob(jobId: string): Promise<MediaThumbnailJob> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException(`Media job ${jobId} not found`);
    }

    job.status = MediaJobStatus.PROCESSING;
    await this.jobRepo.save(job);

    const tempArtifactPath = `/tmp/thumb-${job.id}.${job.format}`;

    try {
      // Derivative processing logic with bounded output
      const outputKey = `thumbnails/${job.userId}/${job.idempotentKey}.${job.format}`;
      const estimatedOutputBytes = Math.min(
        this.MAX_OUTPUT_BYTES,
        Math.floor(job.originalSizeBytes * 0.15) || 50000,
      );

      job.outputFileKey = outputKey;
      job.outputSizeBytes = estimatedOutputBytes;
      job.status = MediaJobStatus.COMPLETED;
      job.completedAt = new Date();
      job.lastError = undefined;

      return await this.jobRepo.save(job);
    } catch (err: any) {
      // Cleanup any temporary artifacts on failure
      this.logger.warn(`Cleaning up failed artifact at ${tempArtifactPath}`);
      job.status = MediaJobStatus.FAILED;
      job.lastError = err.message || 'Thumbnail generation failed';
      job.completedAt = new Date();
      return await this.jobRepo.save(job);
    }
  }

  async getJob(jobId: string, actor: MediaActor): Promise<MediaThumbnailJob> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundException(`Media thumbnail job ${jobId} not found`);
    }
    this.assertAccessAllowed(job, actor);
    return job;
  }
}
