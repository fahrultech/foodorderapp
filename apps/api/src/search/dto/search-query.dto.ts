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
import { sanitizeQueryText } from '../../common/query-sanitizer';

/**
 * Query contract for GET /api/search (Phase 5 "Search: fuzzy name/description
 * match with pg_trgm"). `q` is TRIMMED AND SANITIZED BEFORE validation:
 * illegal codepoints (NUL, other C0/C1 controls, lone surrogates, U+FFFD)
 * are DELETED — Postgres rejects them with SQLSTATE 22021 and the driver
 * would surface that as an HTTP 500 on a public GET (fuzz gate, session 84).
 * A value that is nothing but junk becomes '' and is the same 400 as a
 * blank or missing one. Every property carries class-validator decorators —
 * the global pipe runs with whitelist:true and strips the rest.
 */
export class SearchQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? sanitizeQueryText(value) : value))
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
