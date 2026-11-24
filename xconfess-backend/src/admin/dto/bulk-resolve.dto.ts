import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class BulkResolveDto {
  /**
   * Issue #181: the number of reports resolved in one call is bounded so a
   * single request cannot queue an unbounded amount of nested work.
   */
  @IsArray()
  @ArrayMaxSize(100, { message: 'Maximum 100 report IDs allowed per request' })
  @IsUUID('4', { each: true })
  reportIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/**
 * Issue #184 – preview phase for bulk-resolve.
 * Returns a previewId that callers must present to the commit endpoint.
 */
export class BulkResolvePreviewDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'At least one report ID is required' })
  @ArrayMaxSize(100, { message: 'Maximum 100 report IDs allowed per request' })
  @IsUUID('4', { each: true })
  reportIds: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
