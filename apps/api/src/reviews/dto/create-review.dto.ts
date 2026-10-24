import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of `POST /reviews`. Every property carries a class-validator decorator
 * — the global ValidationPipe (`whitelist: true`) strips anything without one,
 * so `userId`/`restaurantId` injected from a malicious client never reach the
 * service (the order the DTO points at decides both).
 */
export class CreateReviewDto {
  @ApiProperty({ format: 'uuid', description: 'One of the caller\u2019s COMPLETED orders' })
  @IsUUID('4', { message: 'orderId must be a valid order id' })
  orderId: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5, example: 5 })
  @IsInt({ message: 'rating must be a whole number of stars' })
  @Min(1, { message: 'rating must be at least 1 star' })
  @Max(5, { message: 'rating must be at most 5 stars' })
  rating: number;

  /** Optional free text; sending `null` explicitly is the same as omitting it. */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString({ message: 'comment must be text' })
  @MaxLength(2000, { message: 'comment must be at most 2000 characters' })
  comment?: string | null;
}
