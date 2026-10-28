import 'dotenv/config';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { User } from '../users/user.entity';
import { Favorite } from '../users/favorite.entity';
import { DeliveryAddress } from '../users/delivery-address.entity';
import { RefreshToken } from '../auth/refresh-token.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { Order } from '../orders/order.entity';
import { OrderItem } from '../orders/order-item.entity';
import { Review } from '../reviews/review.entity';
import { PromoCode } from '../promos/promo-code.entity';
import { Payment } from '../payments/payment.entity';
import { PaymentRefund } from '../payments/payment-refund.entity';

/**
 * Single source of truth for TypeORM connection + schema options.
 *
 * The Nest app (app.module.ts) and the typeorm CLI both point here.
 * Schema changes are made with migrations only — `synchronize` is OFF:
 *
 *   npm run migration:generate -- src/database/migrations/<Name>   # diff entities vs DB
 *   npm run migration:run        # apply pending migrations
 *   npm run migration:revert     # undo last migration
 *
 * Migrations also run automatically on startup (`migrationsRun: true`),
 * so a fresh database (local dev or docker) bootstraps itself with seed
 * or app boot alone.
 */
export const dataSourceOptions = {
  type: 'postgres' as const,
  url:
    process.env.DATABASE_URL ||
    'postgresql://foodorder:foodorder@localhost:5432/foodorder',
  entities: [User, Favorite, DeliveryAddress, RefreshToken, Restaurant, MenuItem, Order, OrderItem, Review, PromoCode, Payment, PaymentRefund],
  // Glob works for ts-node (src) and compiled output (dist) alike.
  migrations: [path.join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsRun: true,
  synchronize: false,
};

/** Used by `typeorm-ts-node-commonjs` CLI via `-d src/database/data-source.ts`.
 *  Must be the only DataSource export in this file (CLI requirement). */
export const AppDataSource = new DataSource(dataSourceOptions);
