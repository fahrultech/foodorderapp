import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `PATCH /reviews/:id/reply`. REQUIRED `reply` — a patch without it
 * is a 400, never a silent no-op. Clearing a thread is its own verb
 * (`DELETE /reviews/:id/reply`), not an empty string: whitespace-only text
 * is rejected by the service (a response card with invisible content is a
 * lie on the storefront).
 */
export class ReplyReviewDto {
  @ApiProperty({
    type: String,
    maxLength: 2000,
    description: "Owner's public reply shown nested under the review. Whitespace-only answers 400.",
  })
  @IsString({ message: 'reply must be text' })
  @MaxLength(2000, { message: 'reply must be at most 2000 characters' })
  reply: string;
}
