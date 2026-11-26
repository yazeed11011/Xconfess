import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { MediaThumbnailService } from './media-thumbnail.service';
import { CreateThumbnailJobDto } from './dto/create-thumbnail-job.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('media/thumbnails')
@UseGuards(JwtAuthGuard)
export class MediaThumbnailController {
  constructor(private readonly thumbnailService: MediaThumbnailService) {}

  @Post('jobs')
  async createJob(@Request() req: any, @Body() dto: CreateThumbnailJobDto) {
    const actor = { id: req.user.id, role: req.user.role };
    return this.thumbnailService.enqueueThumbnailJob(actor, dto);
  }

  @Get('jobs/:id')
  async getJob(@Request() req: any, @Param('id') id: string) {
    const actor = { id: req.user.id, role: req.user.role };
    return this.thumbnailService.getJob(id, actor);
  }
}
