import { DataSource } from 'typeorm';
import { AppDataSource, dataSourceOptions } from './data-source';
import { User } from '../users/user.entity';
import { Favorite } from '../users/favorite.entity';
import { DeliveryAddress } from '../users/delivery-address.entity';
import { RefreshToken } from '../auth/refresh-token.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { RestaurantHours } from '../restaurants/restaurant-hours.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { MenuOptionGroup } from '../menu/menu-option-group.entity';
import { MenuOptionChoice } from '../menu/menu-option-choice.entity';
import { Order } from '../orders/order.entity';
import { OrderItem } from '../orders/order-item.entity';
import { Review } from '../reviews/review.entity';
import { PromoCode } from '../promos/promo-code.entity';
import { PromoUsage } from '../promos/promo-usage.entity';
import { Payment } from '../payments/payment.entity';
import { PaymentRefund } from '../payments/payment-refund.entity';
import { PushSubscription } from '../notifications/push-subscription.entity';
import { City } from '../cities/city.entity';
import { FeatureFlag } from '../feature-flags/feature-flag.entity';
import { OrderStatusAudit } from '../orders/order-status-audit.entity';
import { InitSchema1792213437047 } from './migrations/1792213437047-InitSchema';
import { MetricsSnapshotRow } from '../common/metrics/metrics-snapshot.entity';

describe('database/data-source', () => {
  it('turns synchronize off and relies on migrations (schema owned by migrations)', () => {
    expect(dataSourceOptions.synchronize).toBe(false);
    expect(dataSourceOptions.migrationsRun).toBe(true);
  });

  it('registers exactly the twenty-one entities and a ts/js migration glob', () => {
    expect(dataSourceOptions.entities).toHaveLength(21);
    expect(dataSourceOptions.entities).toEqual(
      expect.arrayContaining([User, Favorite, DeliveryAddress, RefreshToken, City, Restaurant, RestaurantHours, MenuItem, MenuOptionGroup, MenuOptionChoice, Order, OrderItem, OrderStatusAudit, Review, PromoCode, PromoUsage, Payment, PaymentRefund, PushSubscription, FeatureFlag, MetricsSnapshotRow]),
    );
    expect(dataSourceOptions.migrations).toHaveLength(1);
    expect(dataSourceOptions.migrations[0]).toMatch(/migrations\/\*\.\{ts,js\}$/);
  });

  it('exports exactly one DataSource instance (typeorm CLI requirement)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./data-source');
    const dataSources = Object.values(mod).filter((v) => v instanceof DataSource);
    expect(dataSources).toHaveLength(1);
    expect(dataSources[0]).toBe(AppDataSource);
  });

  it('InitSchema baseline implements up() and down()', () => {
    const migration = new InitSchema1792213437047();
    expect(migration.name).toBe('InitSchema1792213437047');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
