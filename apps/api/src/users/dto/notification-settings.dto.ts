import { IsBoolean, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Self-service notification channel toggles (`PATCH /users/me/notification-settings`).
 *
 * Every property carries a class-validator decorator — the global
 * ValidationPipe (whitelist: true) STRIPS anything else, so an injected
 * `email`/`role`/`id` can never ride through this body. Booleans are
 * strict: `0`/`"false"`/`null` are 400, not silently coerced — a typo'd
 * client must fail loudly instead of quietly flipping a channel.
 * `@ValidateIf(v => v !== undefined)` INSTEAD of `@IsOptional()` on
 * purpose: IsOptional skips validation for `null` too, which would let a
 * literal null through `!== undefined` service checks straight into the
 * NOT NULL column (a 500 class this pin caught at unit time).
 * An empty patch is shape-valid; the service rejects it with 400 rather
 * than pretending to save (same doctrine as UpdateProfileDto).
 */
export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({
    description: 'Receive order confirmation + status-step emails on authenticated orders (guest orders are unaffected — no account to consult)',
  })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  orderEmail?: boolean;

  @ApiPropertyOptional({ description: 'Receive browser-push notifications for own orders (per-device subscriptions still apply on top)' })
  @ValidateIf((_o, v) => v !== undefined)
  @IsBoolean()
  orderPush?: boolean;
}
