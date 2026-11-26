import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum MediaJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('media_thumbnail_jobs')
export class MediaThumbnailJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  @Index()
  userId: number;

  @Column({ name: 'original_file_key', type: 'varchar', length: 512 })
  originalFileKey: string;

  @Column({ name: 'original_mime_type', type: 'varchar', length: 64 })
  originalMimeType: string;

  @Column({ name: 'original_size_bytes', type: 'bigint' })
  originalSizeBytes: number;

  @Column({ name: 'target_width', type: 'integer', default: 320 })
  targetWidth: number;

  @Column({ name: 'target_height', type: 'integer', default: 320 })
  targetHeight: number;

  @Column({ type: 'varchar', length: 16, default: 'webp' })
  format: string;

  @Column({ name: 'idempotent_key', type: 'varchar', length: 128, unique: true })
  @Index()
  idempotentKey: string;

  @Column({ name: 'output_file_key', type: 'varchar', length: 512, nullable: true })
  outputFileKey?: string;

  @Column({ name: 'output_size_bytes', type: 'integer', nullable: true })
  outputSizeBytes?: number;

  @Column({
    type: 'enum',
    enum: MediaJobStatus,
    default: MediaJobStatus.PENDING,
  })
  @Index()
  status: MediaJobStatus;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt?: Date;
}
