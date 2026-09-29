import { Module, forwardRef } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@typeorm/nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LockoutService } from './lockout.service';
import { CacheModule } from '../cache/cache.module';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';
import { StepUpService } from './step-up.service';
import { StepUpGuard } from './guards/step-up.guard';
import { RateLimitGuard } from './guard/rate-limit.guard';
import { RateLimitStore } from './guard/rate-limit.store';
import { UserModule } from '../user/user.module';
import { EmailModule } from '../email/email.module';
import { PasswordReset } from './entities/password-reset.entity';
import { KeyRotationService } from '../securits/key-rotation.service';
import { KeyRotationModule } from '../securits/key-rotation.module';

function buildJwtOptions(
  configService: ConfigService,
  keyRotationService: KeyRotationService,
): JwtModuleOptions {
  const activeKey = keyRotationService.getActiveKey();
  const readableKeys = keyRotationService.getReadableKeys();

  return {
    secret: activeKey.material,
    signOptions: {
      expiresIn: configService.get<string>('JWT_EXPIRES_IN') ?? '1d',
      keyid: activeKey.version,
    },
    verifyOptions: {
      secret: readableKeys.map((key) => key.material),
    },
  };
}

@Module({
  imports: [
    forwardRef(() => UserModule),
    CacheModule,
    EmailModule,
    AnalyticsModule,
    PassportModule,
    KeyRotationModule,
    TypeOrmModule.forFeature([PasswordReset]),
    JwtModule.registerAsync({
      imports: [ConfigModule, KeyRotationModule],
      inject: [ConfigService, KeyRotationService],
      useFactory: buildJwtOptions,
    }),
  ],
  controllers: [AuthController, AccountMergeController],
  providers: [
    LockoutService,
    AuthService,
    JwtStrategy,
    PasswordResetService,
    EmailChangeService,
    StepUpService,
    StepUpGuard,
    OptionalJwtAuthGuard,
    RateLimitStore,
    RateLimitGuard,
  ],
  exports: [
    AuthService,
    LockoutService,
    JwtModule,
    EmailChangeService,
    StepUpService,
    StepUpGuard,
    OptionalJwtAuthGuard,
    RateLimitStore,
    RateLimitGuard,
  ],
})
export class AuthModule {}
