import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/**
 * Body of `POST /reviews`. Every property carries a class-validator decorator
 * — the global ValidationPipe (`whitelist: true`) strips anything without one,
 * so `userId`/`restaurantId` injected from a malicious client never reach the
 * service (the order the DTO points at decides both).
 */
export class CreateReviewDto {
  @IsUUID('4', { message: 'orderId must be a valid order id' })
  orderId: string;

  @IsInt({ message: 'rating must be a whole number of stars' })
  @Min(1, { message: 'rating must be at least 1 star' })
  @Max(5, { message: 'rating must be at most 5 stars' })
  rating: number;

  /** Optional free text; sending `null` explicitly is the same as omitting it. */
  @IsOptional()
  @IsString({ message: 'comment must be text' })
  @MaxLength(2000, { message: 'comment must be at most 2000 characters' })
  comment?: string | null;
}
