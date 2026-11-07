import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Public fuzzy search (Phase 5, session 69). Reads only — the two entity
 * repos exist for the raw trigram queries; the shared `attachHours`
 * derivation comes from RestaurantsModule so every storefront read agrees.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Restaurant, MenuItem]), RestaurantsModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
