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
import { AddressesService } from './addresses.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AddFavoriteDto } from './dto/add-favorite.dto';
import {
  CreateDeliveryAddressDto,
  UpdateDeliveryAddressDto,
} from './dto/delivery-address.dto';
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
    private readonly addresses: AddressesService,
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

  // --- delivery address book ---

  /** The caller's saved addresses: default first, then oldest added first. */
  @Get('me/addresses')
  @UseGuards(JwtAuthGuard)
  listAddresses(@CurrentUser() user: any) {
    return this.addresses.list(user.sub);
  }

  /**
   * Save a new address. The first one for the account is forced default;
   * `isDefault: true` afterwards promotes it (exactly-one-default stays
   * intact). Book capped at 10 rows -> 400 when full.
   */
  @Post('me/addresses')
  @UseGuards(JwtAuthGuard)
  createAddress(@CurrentUser() user: any, @Body() dto: CreateDeliveryAddressDto) {
    return this.addresses.create(user.sub, dto);
  }

  /** Edit text fields of one own address. Foreign/unknown id -> 404. */
  @Patch('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  updateAddress(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateDeliveryAddressDto,
  ) {
    if (!isUuid(id)) throw new NotFoundException('Delivery address not found');
    return this.addresses.update(user.sub, id, dto);
  }

  /**
   * Delete. Idempotent `{removed}` answer (no 404 on a retried delete — same
   * contract as un-hearting). Removing the default promotes the oldest
   * survivor; the response names it via `promotedDefaultId` when that happens.
   */
  @Delete('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  deleteAddress(@CurrentUser() user: any, @Param('id') id: string) {
    if (!isUuid(id)) return { removed: false };
    return this.addresses.remove(user.sub, id);
  }

  /** Promote one address to default. Idempotent (`alreadyDefault:true`). */
  @Post('me/addresses/:id/default')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  setDefaultAddress(@CurrentUser() user: any, @Param('id') id: string) {
    if (!isUuid(id)) throw new NotFoundException('Delivery address not found');
    return this.addresses.setDefault(user.sub, id);
  }
}
