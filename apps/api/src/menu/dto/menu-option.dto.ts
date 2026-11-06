import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Shared bounds — mirror the migration CHECKs exactly. */
export const OPTION_MIN_CHOICES_MAX = 20;
export const OPTION_MAX_CHOICES_MAX = 20;
export const OPTION_PRICE_DELTA_MAX_CENTS = 10000000;

export class CreateOptionChoiceDto {
  @ApiProperty({ maxLength: 80, example: 'Extra egg' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'choice name must contain non-whitespace characters' })
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: OPTION_PRICE_DELTA_MAX_CENTS,
    description: 'Extra cents on top of the dish base price (integer cents; free choices = 0).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OPTION_PRICE_DELTA_MAX_CENTS)
  @Type(() => Number)
  priceDeltaCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000, description: 'Display order inside the group.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  position?: number;
}

/**
 * Owner creates a whole group with its choices in one call. Money is
 * integer cents; a group without choices is useless for ordering, hence
 * the ArrayMinSize(1).
 */
export class CreateOptionGroupDto {
  @ApiProperty({ maxLength: 80, example: 'Size' })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'group name must contain non-whitespace characters' })
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: OPTION_MIN_CHOICES_MAX,
    description: 'Selections an order line MUST include (0 = group optional). Default 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OPTION_MIN_CHOICES_MAX)
  @Type(() => Number)
  minChoices?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: OPTION_MAX_CHOICES_MAX,
    description: 'Selections an order line MAY include (1 = radio "pick one"). Default 1. Must be >= minChoices.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(OPTION_MAX_CHOICES_MAX)
  @Type(() => Number)
  maxChoices?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000, description: 'Display order on the dish.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  position?: number;

  @ApiProperty({ type: [CreateOptionChoiceDto], minItems: 1, maxItems: 20 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateOptionChoiceDto)
  choices: CreateOptionChoiceDto[];
}

/** Partial update — every field optional, min<=max re-checked server-side. */
export class UpdateOptionGroupDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'group name must contain non-whitespace characters' })
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: OPTION_MIN_CHOICES_MAX })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OPTION_MIN_CHOICES_MAX)
  @Type(() => Number)
  minChoices?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: OPTION_MAX_CHOICES_MAX })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(OPTION_MAX_CHOICES_MAX)
  @Type(() => Number)
  maxChoices?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  position?: number;
}

export class UpdateOptionChoiceDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'choice name must contain non-whitespace characters' })
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: OPTION_PRICE_DELTA_MAX_CENTS, description: 'Replace the delta in integer cents.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(OPTION_PRICE_DELTA_MAX_CENTS)
  @Type(() => Number)
  priceDeltaCents?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  @Type(() => Number)
  position?: number;
}
