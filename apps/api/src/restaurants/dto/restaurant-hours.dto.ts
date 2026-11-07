import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TIME_RE } from '../open-hours';

/** One weekly window. Bounds mirror the `restaurant_hours` CHECK domains. */
export class RestaurantHourDto {
  @ApiProperty({
    minimum: 0,
    maximum: 6,
    example: 1,
    description: '0 = Sunday ... 6 = Saturday (JS getDay convention).',
  })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek: number;

  @ApiProperty({
    pattern: '([01]\\d|2[0-3]):[0-5]\\d',
    example: '08:00',
    description: 'Window start, "HH:MM" 24h (inclusive).',
  })
  @Matches(TIME_RE, { message: 'opensAt must be HH:MM in 24h form' })
  opensAt: string;

  @ApiProperty({
    pattern: '([01]\\d|2[0-3]):[0-5]\\d',
    example: '22:00',
    description:
      'Window end, "HH:MM" 24h (exclusive). <= opensAt wraps past midnight; equal to opensAt is rejected.',
  })
  @Matches(TIME_RE, { message: 'closesAt must be HH:MM in 24h form' })
  closesAt: string;
}

/**
 * WEEKLY open-hours schedule replacement (PUT semantics): `days` is the
 * COMPLETE new schedule — a weekday without a row is closed. `days: []`
 * clears the schedule entirely, which re-enables the legacy manual `isOpen`
 * toggle fallback.
 */
export class UpdateRestaurantHoursDto {
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    maxLength: 64,
    example: 'Asia/Jakarta',
    description:
      'IANA zone the schedule is interpreted in. Omitted keeps the current value; explicit null resets to the server-local zone.',
  })
  @IsOptional()
  @ValidateIf((o) => o.timeZone !== null)
  @IsString()
  @MaxLength(64)
  timeZone?: string | null;

  @ApiProperty({
    type: [RestaurantHourDto],
    maxItems: 7,
    description:
      'Complete replacement schedule. Duplicate dayOfWeek and opensAt === closesAt answer 400.',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => RestaurantHourDto)
  days: RestaurantHourDto[];
}
