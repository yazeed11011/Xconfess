import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum DigestStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  DEFERRED = 'DEFERRED',
  SUPPRESSED_QUIET_HOURS = 'SUPPRESSED_QUIET_HOURS',
  SUPPRESSED_PRIVACY = 'SUPPRESSED_PRIVACY',
}

@Entity('notification_digest_records')
export class NotificationDigestRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'integer' })
  @Index()
  userId: number;

  @Column({ name: 'digest_key', type: 'varchar', length: 128, unique: true })
  @Index()
  digestKey: string;

  @Column({ name: 'window_start', type: 'timestamptz' })
  windowStart: Date;

  @Column({ name: 'window_end', type: 'timestamptz' })
  windowEnd: Date;

  @Column({ name: 'total_events', type: 'integer', default: 0 })
  totalEvents: number;

  @Column({ name: 'included_events', type: 'jsonb', default: [] })
  includedEvents: Record<string, any>[];

  @Column({
    type: 'enum',
    enum: DigestStatus,
    default: DigestStatus.PENDING,
  })
  status: DigestStatus;

  @Column({ type: 'varchar', length: 32, default: 'email' })
  channel: string;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
