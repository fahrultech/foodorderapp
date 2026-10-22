import { IsUUID } from 'class-validator';

/**
 * Body of `POST /users/me/favorites`. Every DTO property needs a decorator —
 * the global ValidationPipe (`whitelist: true`) strips anything without one.
 */
export class AddFavoriteDto {
  @IsUUID('4', { message: 'menuItemId must be a valid dish id' })
  menuItemId: string;
}
