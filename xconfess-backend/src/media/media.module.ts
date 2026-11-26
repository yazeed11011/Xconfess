import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaThumbnailJob } from './entities/media-thumbnail-job.entity';
import { MediaThumbnailService } from './media-thumbnail.service';
import { MediaThumbnailController } from './media-thumbnail.controller';

@Module({
  imports: [TypeOrmModule.forFeature([MediaThumbnailJob])],
  controllers: [MediaThumbnailController],
  providers: [MediaThumbnailService],
  exports: [MediaThumbnailService],
})
export class MediaModule {}
