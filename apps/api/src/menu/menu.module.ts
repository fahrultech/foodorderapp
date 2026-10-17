import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MenuItem } from './menu-item.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuService } from './menu.service';
import { MenuController } from './menu.controller';
import { MenuItemsController } from './menu-items.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  // Restaurant repo: owner routes check ownership of the dish's parent.
  // AuthModule exports JwtModule — required for JwtAuthGuard (lesson from
  // session 1/3: missing AuthModule import crashes Nest DI at boot).
  imports: [TypeOrmModule.forFeature([MenuItem, Restaurant]), AuthModule],
  providers: [MenuService],
  controllers: [MenuController, MenuItemsController],
  exports: [MenuService],
})
export class MenuModule {}
