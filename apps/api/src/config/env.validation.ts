/**
 * Boot-time environment validation.
 *
 * ConfigModule.forRoot({ validate }) runs this BEFORE any module is
 * initialised.  If validation fails the process exits with a clear message
 * listing every missing/invalid variable — no silent fallbacks or cryptic
 * downstream errors.
 *
 * Usage: pass `validateEnv` to ConfigModule.forRoot({ validate: validateEnv }).
 */
import { plainToInstance } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  validateSync,
  IsUrl,
  IsEnum,
} from 'class-validator';

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
}

export class EnvVars {
  // ── Required ────────────────────────────────────────────────────────────
  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL must be set (postgresql://user:pass@host/db)' })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'JWT_SECRET must be set to a strong secret' })
  JWT_SECRET!: string;

  // ── Optional with sensible defaults ─────────────────────────────────────
  @IsOptional()
  @IsString()
  JWT_ACCESS_TTL?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_TTL?: string;

  @IsOptional()
  @IsEnum(LogLevel, {
    message: `LOG_LEVEL must be one of: ${Object.values(LogLevel).join(', ')}`,
  })
  LOG_LEVEL?: LogLevel;

  @IsOptional()
  @IsString()
  PORT?: string;

  @IsOptional()
  @IsString()
  PAYMENT_PROVIDER?: string;

  @IsOptional()
  @IsIn(['succeed', 'fail'], {
    message: 'MOCK_PAY_GATEWAY_MODE must be "succeed" or "fail"',
  })
  MOCK_PAY_GATEWAY_MODE?: string;

  @IsOptional()
  @IsIn(['succeed', 'fail'], {
    message: 'MOCK_REFUND_GATEWAY_MODE must be "succeed" or "fail"',
  })
  MOCK_REFUND_GATEWAY_MODE?: string;

  @IsOptional()
  @IsString()
  ORDER_CONFIRM_REQUIRES_PAYMENT?: string;

  @IsOptional()
  @IsString()
  STALE_ORDER_MINUTES?: string;

  @IsOptional()
  @IsString()
  STALE_ORDER_BATCH?: string;

  // ── SMTP (all optional — unset disables email) ───────────────────────────
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsOptional()
  @IsString()
  SMTP_PORT?: string;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsOptional()
  @IsString()
  SMTP_FROM?: string;

  @IsOptional()
  @IsString()
  SMTP_SECURE?: string;

  // ── Rate limiting (all optional) ─────────────────────────────────────────
  @IsOptional()
  @IsString()
  RATE_LIMIT_AUTH_MAX?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_AUTH_WINDOW_SEC?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_ORDERS_MAX?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_ORDERS_WINDOW_SEC?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_PAYMENTS_MAX?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_PAYMENTS_WINDOW_SEC?: string;

  @IsOptional()
  @IsString()
  RATE_LIMIT_TRUST_PROXY?: string;
}

/**
 * Validates the raw process.env object against EnvVars.
 * Pass this to `ConfigModule.forRoot({ validate: validateEnv })`.
 * On failure throws with a human-readable list of all constraint violations.
 */
export function validateEnv(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    // Keep all keys — don't strip unknowns (we only validate the declared ones)
    excludeExtraneousValues: false,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    stopAtFirstError: false,
  });

  if (errors.length > 0) {
    const messages = errors
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .join('\n  ');
    throw new Error(
      `\n\nBoot-time configuration validation failed — fix these env vars before starting:\n\n  ${messages}\n`,
    );
  }

  return validated;
}
