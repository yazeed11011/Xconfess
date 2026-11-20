import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaAndNotificationDigests20261120000002 implements MigrationInterface {
  name = 'AddMediaAndNotificationDigests20261120000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "media_thumbnail_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" integer NOT NULL,
        "original_file_key" varchar(512) NOT NULL,
        "original_mime_type" varchar(64) NOT NULL,
        "original_size_bytes" bigint NOT NULL,
        "target_width" integer NOT NULL DEFAULT 320,
        "target_height" integer NOT NULL DEFAULT 320,
        "format" varchar(16) NOT NULL DEFAULT 'webp',
        "idempotent_key" varchar(128) NOT NULL UNIQUE,
        "output_file_key" varchar(512),
        "output_size_bytes" integer,
        "status" varchar(32) NOT NULL DEFAULT 'PENDING',
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        CONSTRAINT "PK_media_thumbnail_jobs" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_media_thumbnail_jobs_user_id"
        ON "media_thumbnail_jobs" ("user_id");
      CREATE INDEX IF NOT EXISTS "IDX_media_thumbnail_jobs_status"
        ON "media_thumbnail_jobs" ("status");

      CREATE TABLE IF NOT EXISTS "notification_digest_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" integer NOT NULL,
        "digest_key" varchar(128) NOT NULL UNIQUE,
        "window_start" timestamptz NOT NULL,
        "window_end" timestamptz NOT NULL,
        "total_events" integer NOT NULL DEFAULT 0,
        "included_events" jsonb NOT NULL DEFAULT '[]',
        "status" varchar(32) NOT NULL DEFAULT 'PENDING',
        "channel" varchar(32) NOT NULL DEFAULT 'email',
        "delivered_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_digest_records" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_notification_digest_records_user_id"
        ON "notification_digest_records" ("user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "notification_digest_records"');
    await queryRunner.query('DROP TABLE IF EXISTS "media_thumbnail_jobs"');
  }
}
