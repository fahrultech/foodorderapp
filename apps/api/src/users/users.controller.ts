import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { FavoritesService } from './favorites.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AddFavoriteDto } from './dto/add-favorite.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { isUuid } from '../common/uuid';

/**
 * Routes a user has about their own account. Everything here is scoped to the
 * authenticated caller by construction — the id comes from the JWT subject,
 * never from the URL or body, so there is no "…/:id" variant to leak.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly favorites: FavoritesService,
  ) {}

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.sub, dto);
  }

  /** All dishes the caller hearted, newest first. */
  @Get('me/favorites')
  @UseGuards(JwtAuthGuard)
  listFavorites(@CurrentUser() user: any) {
    return this.favorites.list(user.sub);
  }

  /**
   * Heart a dish (idempotent — re-adding an existing favorite returns
   * `created:false`, so a retried click is a no-op). Status is pinned to 200
   * for both outcomes; `created` tells the client whether the row changed.
   */
  @Post('me/favorites')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  addFavorite(@CurrentUser() user: any, @Body() dto: AddFavoriteDto) {
    return this.favorites.add(user.sub, dto.menuItemId);
  }

  /**
   * Un-heart. Malformed ids are 404 (same "unknown resource" semantics the
   * uuid guard uses elsewhere — the value never reaches Postgres as-is).
   */
  @Delete('me/favorites/:menuItemId')
  @UseGuards(JwtAuthGuard)
  removeFavorite(@CurrentUser() user: any, @Param('menuItemId') menuItemId: string) {
    if (!isUuid(menuItemId)) throw new NotFoundException('Favorite not found');
    return this.favorites.remove(user.sub, menuItemId);
  }
}
