import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  IsIn,
} from 'class-validator';

export class CreateThumbnailJobDto {
  @IsString()
  @IsNotEmpty()
  originalFileKey: string;

  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'], {
    message: 'Only image/jpeg, image/png, and image/webp are supported',
  })
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(15 * 1024 * 1024, {
    message: 'Original media size exceeds maximum bound of 15MB',
  })
  sizeBytes: number;

  @IsOptional()
  @IsInt()
  @Min(32)
  @Max(640, {
    message: 'Thumbnail target width cannot exceed 640px',
  })
  targetWidth?: number;

  @IsOptional()
  @IsInt()
  @Min(32)
  @Max(640, {
    message: 'Thumbnail target height cannot exceed 640px',
  })
  targetHeight?: number;

  @IsOptional()
  @IsString()
  @IsIn(['webp', 'jpeg', 'png'])
  format?: string;
}
