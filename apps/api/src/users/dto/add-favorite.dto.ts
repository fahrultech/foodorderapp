import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Body of `POST /users/me/favorites`. Every DTO property needs a decorator —
 * the global ValidationPipe (`whitelist: true`) strips anything without one.
 */
export class AddFavoriteDto {
  @ApiProperty({ format: 'uuid', description: 'Dish id to heart' })
  @IsUUID('4', { message: 'menuItemId must be a valid dish id' })
  menuItemId: string;
}
