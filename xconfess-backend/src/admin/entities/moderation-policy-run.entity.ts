import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum ModerationPolicyRunKind {
  SHADOW = 'shadow',
  PREVIEW = 'preview',
  BULK_RESOLVE_PREVIEW = 'bulk_preview',
}

export enum ModerationPolicyRunStatus {
  COMPLETED = 'completed',
  PENDING = 'pending',
  COMMITTED = 'committed',
  ROLLED_BACK = 'rolled_back',
  EXPIRED = 'expired',
}

@Entity('moderation_policy_runs')
@Index(['createdById', 'kind', 'createdAt'])
@Index(['status', 'expiresAt'])
export class ModerationPolicyRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'created_by_id', type: 'int' })
  createdById: number;

  @Column({ type: 'varchar', length: 16 })
  kind: ModerationPolicyRunKind;

  @Column({ type: 'varchar', length: 16 })
  status: ModerationPolicyRunStatus;

  @Column({ type: 'jsonb' })
  details: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'committed_at', type: 'timestamptz', nullable: true })
  committedAt: Date | null;

  @Column({ name: 'rolled_back_at', type: 'timestamptz', nullable: true })
  rolledBackAt: Date | null;
}
