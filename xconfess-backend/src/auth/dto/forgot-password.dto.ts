import {
  IsOptional,
  IsEmail,
  IsNumber,
  ValidateIf,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiPropertyOptional({
    description: 'Registered e-mail address. Provide either email or userId.',
    example: 'alice@example.com',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @ValidateIf((o) => !o.userId || o.email)
  email?: string;

  @ApiPropertyOptional({
    description: 'Numeric user ID. Provide either email or userId.',
    example: 42,
  })
  @IsOptional()
  @IsNumber({}, { message: 'User ID must be a number' })
  @ValidateIf((o) => !o.email || o.userId)
  userId?: number;

  @ApiPropertyOptional({
    description:
      'Opaque client-supplied request identifier used for privacy-preserving audit correlation. Never logged verbatim.',
    example: 'req_7f3c1a9b',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;

  // Custom validation to ensure at least one field is provided
  static validate(dto: ForgotPasswordDto): boolean {
    return !!(dto.email || dto.userId);
  }
}
