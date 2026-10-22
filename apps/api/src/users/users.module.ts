import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { Favorite } from './favorite.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { FavoritesService } from './favorites.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule exports JwtModule — required for JwtAuthGuard on /users/me
  // (same DI lesson already recorded for menu and restaurants modules).
  // MenuItem repo is for the favorites dish-existence check only; MenuModule
  // deliberately not imported to avoid a users<->menu module cycle.
  imports: [TypeOrmModule.forFeature([User, Favorite, MenuItem]), AuthModule],
  controllers: [UsersController],
  providers: [UsersService, FavoritesService],
  exports: [UsersService],
})
export class UsersModule {}
