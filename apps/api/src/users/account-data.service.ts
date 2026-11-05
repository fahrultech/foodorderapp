import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from './user.entity';
import { DeliveryAddress } from './delivery-address.entity';
import { Favorite } from './favorite.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Payment } from '../payments/payment.entity';
import { Review } from '../reviews/review.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { PaymentRefund } from '../payments/payment-refund.entity';
import { RefreshToken } from '../auth/refresh-token.entity';
import { PushSubscription } from '../notifications/push-subscription.entity';
import { DEFAULT_RATING } from '../reviews/reviews.service';
import { toSafeUser } from '../common/safe-user';

const ACTIVE_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING,
  OrderStatus.DELIVERING,
];

function mapAddress(row: DeliveryAddress) {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    phone: row.phone,
    address: row.address,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOrder(row: Order) {
  return {
    id: row.id,
    code: row.code,
    userId: row.userId ?? null,
    restaurantId: row.restaurantId,
    driverId: row.driverId ?? null,
    status: row.status,
    confirmedAt: row.confirmedAt ?? null,
    preparingAt: row.preparingAt ?? null,
    deliveringAt: row.deliveringAt ?? null,
    completedAt: row.completedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    promoCode: row.promoCode ?? null,
    deliveryFeeCents: row.deliveryFeeCents,
    totalCents: row.totalCents,
    customerName: row.customerName,
    contactPhone: row.contactPhone,
    deliveryAddress: row.deliveryAddress,
    note: row.note ?? null,
    items: (row.items ?? []).map((item) => ({
      id: item.id,
      orderId: item.orderId,
      menuItemId: item.menuItemId ?? null,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPayment(row: Payment) {
  return {
    id: row.id,
    orderId: row.orderId,
    userId: row.userId ?? null,
    provider: row.provider,
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    providerRef: row.providerRef ?? null,
    failureReason: row.failureReason ?? null,
    succeededAt: row.succeededAt ?? null,
    refundedCents: row.refundedCents,
    refundedAt: row.refundedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRestaurant(row: Restaurant) {
  return {
    id: row.id,
    ownerId: row.ownerId ?? null,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    cuisine: row.cuisine ?? null,
    city: row.city ?? null,
    cityId: row.cityId ?? null,
    address: row.address ?? null,
    imageUrl: row.imageUrl ?? null,
    rating: row.rating,
    ratingCount: row.ratingCount,
    deliveryFeeCents: row.deliveryFeeCents,
    minOrderCents: row.minOrderCents,
    avgPrepMinutes: row.avgPrepMinutes,
    isOpen: row.isOpen,
    menuItems: (row.menuItems ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description ?? null,
      priceCents: item.priceCents,
      category: item.category ?? null,
      imageUrl: item.imageUrl ?? null,
      isAvailable: item.isAvailable,
      prepMinutes: item.prepMinutes,
      restaurantId: item.restaurantId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class AccountDataService {
  constructor(private readonly dataSource: DataSource) {}

  async exportForUser(userId: string) {
    const manager = this.dataSource.manager;
    const users = manager.getRepository(User);
    const user = await users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const [addresses, favorites, orders, payments, reviews, ownedRestaurants, driverAssignments, refunds, sessions, pushSubscriptions] = await Promise.all([
      manager.getRepository(DeliveryAddress).find({ where: { userId }, order: { isDefault: 'DESC', createdAt: 'ASC' } }),
      manager.getRepository(Favorite).find({ where: { userId }, relations: { menuItem: { restaurant: true } }, order: { createdAt: 'DESC' } }),
      manager.getRepository(Order).find({ where: { userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(Payment).find({ where: { userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(Review).find({ where: { userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(Restaurant).find({ where: { ownerId: userId }, relations: { menuItems: true }, order: { createdAt: 'ASC' } }),
      manager.getRepository(Order).find({ where: { driverId: userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(PaymentRefund).find({ where: { actingAdminId: userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(RefreshToken).find({ where: { userId }, order: { createdAt: 'DESC' } }),
      manager.getRepository(PushSubscription).find({ where: { userId }, order: { createdAt: 'DESC' } }),
    ]);

    return {
      schemaVersion: 1,
      generatedAt: new Date(),
      profile: toSafeUser(user),
      addresses: addresses.map(mapAddress),
      favorites: favorites.map((favorite) => ({
        id: favorite.id,
        menuItemId: favorite.menuItemId,
        createdAt: favorite.createdAt,
        menuItem: favorite.menuItem
          ? {
              id: favorite.menuItem.id,
              name: favorite.menuItem.name,
              restaurantId: favorite.menuItem.restaurantId,
              restaurant: favorite.menuItem.restaurant
                ? {
                    id: favorite.menuItem.restaurant.id,
                    name: favorite.menuItem.restaurant.name,
                    slug: favorite.menuItem.restaurant.slug,
                  }
                : null,
            }
          : null,
      })),
      orders: orders.map(mapOrder),
      paymentsMade: payments.map(mapPayment),
      reviews: reviews.map((review) => ({
        id: review.id,
        orderId: review.orderId,
        restaurantId: review.restaurantId,
        rating: review.rating,
        comment: review.comment ?? null,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt,
      })),
      ownedRestaurants: ownedRestaurants.map(mapRestaurant),
      driverAssignments: driverAssignments.map(mapOrder),
      refundsIssued: refunds.map((refund) => ({
        id: refund.id,
        paymentId: refund.paymentId,
        provider: refund.provider,
        providerRefundRef: refund.providerRefundRef ?? null,
        amountCents: refund.amountCents,
        refundedAfterCents: refund.refundedAfterCents,
        actingAdminId: refund.actingAdminId ?? null,
        actingAdminEmail: refund.actingAdminEmail ?? null,
        createdAt: refund.createdAt,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt ?? null,
        createdAt: session.createdAt,
      })),
      pushSubscriptions: pushSubscriptions.map((subscription) => ({
        id: subscription.id,
        endpoint: subscription.endpoint,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      })),
    };
  }

  async deleteForUser(userId: string, password: string) {
    return this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const orders = manager.getRepository(Order);
      const restaurants = manager.getRepository(Restaurant);
      const reviews = manager.getRepository(Review);
      const refunds = manager.getRepository(PaymentRefund);

      const user = await users.findOne({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      if (!(await bcrypt.compare(password, user.passwordHash))) {
        throw new UnauthorizedException('Invalid password');
      }

      if (user.role === UserRole.ADMIN) {
        const admins = await users.find({
          where: { role: UserRole.ADMIN },
          select: { id: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (admins.length <= 1) throw new ConflictException('The last administrator cannot delete their account');
      }

      if (user.role === UserRole.DRIVER) {
        const activeAssignments = await orders.count({ where: { driverId: userId, status: In(ACTIVE_ORDER_STATUSES) } });
        if (activeAssignments > 0) throw new ConflictException('Complete or reassign active deliveries before deleting the account');
      }

      const owned = await restaurants.find({ where: { ownerId: userId }, select: { id: true } });
      const ownedIds = owned.map((restaurant) => restaurant.id);
      if (ownedIds.length > 0) {
        const activeOwnedOrders = await orders.count({ where: { restaurantId: In(ownedIds), status: In(ACTIVE_ORDER_STATUSES) } });
        if (activeOwnedOrders > 0) throw new ConflictException('Resolve active restaurant orders before deleting the account');
      }

      const affectedReviewRows = await reviews.find({ where: { userId }, select: { restaurantId: true } });
      const affectedRestaurantIds = [...new Set(affectedReviewRows.map((review) => review.restaurantId))];
      const anonymized = await orders.update(
        { userId },
        { customerName: 'Deleted user', contactPhone: '[deleted]', deliveryAddress: '[deleted]', note: null },
      );
      await refunds.update({ actingAdminId: userId }, { actingAdminEmail: null });
      const unassignedOrders = await orders.count({ where: { driverId: userId } });
      await users.delete(userId);

      for (const restaurantId of affectedRestaurantIds) {
        const [stats] = await manager.query<Array<{ rating: number; count: number }>>(
          `SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), $2::numeric)::float8 AS rating,
                  COUNT(*)::int AS count
             FROM reviews WHERE "restaurantId" = $1`,
          [restaurantId, DEFAULT_RATING],
        );
        await restaurants.update(
          { id: restaurantId },
          { rating: Number(stats.rating), ratingCount: Number(stats.count) },
        );
      }

      return {
        deleted: true,
        anonymizedOrders: anonymized.affected ?? 0,
        detachedRestaurants: ownedIds.length,
        unassignedOrders,
      };
    });
  }
}
