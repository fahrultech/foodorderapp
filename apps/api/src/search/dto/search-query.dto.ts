import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * Query contract for GET /api/search (Phase 5 "Search: fuzzy name/description
 * match with pg_trgm"). `q` is trimmed BEFORE validation, so a blank string is
 * the same 400 as a missing one. Every property carries class-validator
 * decorators — the global pipe runs with whitelist:true and strips the rest.
 */
export class SearchQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'q must not be empty' })
  @MaxLength(100, { message: 'q must be at most 100 characters' })
  q: string;

  /** Per-side cap (the response carries BOTH restaurants and dishes). */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(25)
  limit?: number;
}
