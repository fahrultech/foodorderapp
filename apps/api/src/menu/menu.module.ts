import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MenuItem } from './menu-item.entity';
import { MenuOptionGroup } from './menu-option-group.entity';
import { MenuOptionChoice } from './menu-option-choice.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuService } from './menu.service';
import { MenuOptionService } from './menu-option.service';
import { MenuController } from './menu.controller';
import { MenuItemsController } from './menu-items.controller';
import { MenuOptionsController } from './menu-options.controller';
import { AuthModule } from '../auth/auth.module';
import { MenuImageService } from './menu-image.service';

@Module({
  // Restaurant repo: owner routes check ownership of the dish's parent.
  // AuthModule exports JwtModule — required for JwtAuthGuard (lesson from
  // session 1/3: missing AuthModule import crashes Nest DI at boot).
  imports: [
    TypeOrmModule.forFeature([
      MenuItem,
      MenuOptionGroup,
      MenuOptionChoice,
      Restaurant,
    ]),
    AuthModule,
  ],
  providers: [MenuService, MenuImageService, MenuOptionService],
  controllers: [MenuController, MenuItemsController, MenuOptionsController],
  exports: [MenuService, MenuOptionService],
})
export class MenuModule {}
