import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of `PATCH /reviews/:id`. Both fields optional — but a patch that
 * carries neither is a 400 (never a silent no-op "success", same policy as
 * `PATCH /users/me`). `comment: null` clears the text; omitting it keeps it.
 */
export class UpdateReviewDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt({ message: 'rating must be a whole number of stars' })
  @Min(1, { message: 'rating must be at least 1 star' })
  @Max(5, { message: 'rating must be at most 5 stars' })
  rating?: number;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'null clears the comment; omit keeps it' })
  @IsOptional()
  @IsString({ message: 'comment must be text' })
  @MaxLength(2000, { message: 'comment must be at most 2000 characters' })
  comment?: string | null;
}
