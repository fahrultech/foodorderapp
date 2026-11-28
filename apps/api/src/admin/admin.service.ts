import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from '../orders/order.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User, UserRole } from '../users/user.entity';
import { toSafeUser } from '../common/safe-user';

export const ADMIN_RECENT_USERS_LIMIT = 10;
export const ADMIN_RECENT_RESTAURANTS_LIMIT = 10;
export const ADMIN_RECENT_ORDERS_LIMIT = 20;

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Restaurant) private readonly restaurants: Repository<Restaurant>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  async overview() {
    const [
      userTotal,
      customers,
      owners,
      admins,
      drivers,
      restaurantTotal,
      openRestaurants,
      orderStats,
      recentUsers,
      recentRestaurants,
      recentOrders,
    ] = await Promise.all([
      this.users.count(),
      this.users.count({ where: { role: UserRole.CUSTOMER } }),
      this.users.count({ where: { role: UserRole.OWNER } }),
      this.users.count({ where: { role: UserRole.ADMIN } }),
      this.users.count({ where: { role: UserRole.DRIVER } }),
      this.restaurants.count(),
      this.restaurants.count({ where: { isOpen: true } }),
      // Session 146 (Phase 17 eager audit): the seven plain repo counts each
      // rode the EAGER `items` relation (COUNT(DISTINCT id) LEFT JOIN
      // order_items — live-proven, the session-144 finding generalized to
      // this route). ONE join-free GROUP BY status QueryBuilder serves total
      // AND every per-status number; the response is byte-identical.
      this.orderStats(),
      this.users.find({
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          address: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
        order: { createdAt: 'DESC' },
        take: ADMIN_RECENT_USERS_LIMIT,
      }),
      this.restaurants.find({
        relations: { owner: true },
        order: { createdAt: 'DESC' },
        take: ADMIN_RECENT_RESTAURANTS_LIMIT,
      }),
      this.orders.find({
        relations: { restaurant: true },
        loadEagerRelations: false,
        order: { createdAt: 'DESC' },
        take: ADMIN_RECENT_ORDERS_LIMIT,
      }),
    ]);
    const { total: orderTotal, byStatus } = orderStats;

    return {
      counts: {
        users: {
          total: userTotal,
          customer: customers,
          owner: owners,
          admin: admins,
          driver: drivers,
        },
        restaurants: { total: restaurantTotal, open: openRestaurants },
        orders: {
          total: orderTotal,
          pending: byStatus[OrderStatus.PENDING],
          confirmed: byStatus[OrderStatus.CONFIRMED],
          preparing: byStatus[OrderStatus.PREPARING],
          delivering: byStatus[OrderStatus.DELIVERING],
          completed: byStatus[OrderStatus.COMPLETED],
          cancelled: byStatus[OrderStatus.CANCELLED],
        },
      },
      recentUsers: recentUsers.map(toSafeUser),
      recentRestaurants: recentRestaurants.map((restaurant) => ({
        id: restaurant.id,
        slug: restaurant.slug,
        name: restaurant.name,
        ownerId: restaurant.ownerId,
        ownerName: restaurant.owner?.name ?? null,
        city: restaurant.city,
        isOpen: restaurant.isOpen,
        rating: restaurant.rating,
        createdAt: restaurant.createdAt,
      })),
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        code: order.code,
        status: order.status,
        totalCents: order.totalCents,
        customerName: order.customerName,
        userId: order.userId,
        restaurantId: order.restaurantId,
        restaurantName: order.restaurant?.name ?? null,
        createdAt: order.createdAt,
      })),
    };
  }

  /**
   * ONE join-free statement behind all seven overview numbers (session 146):
   * a QueryBuilder never rides the eager `items` relation, and summing the
   * GROUP BY rows reproduces the old separate COUNT(DISTINCT id) totals
   * exactly (each status group is disjoint; `total` == COUNT over all rows).
   */
  private async orderStats(): Promise<{
    total: number;
    byStatus: Record<OrderStatus, number>;
  }> {
    const byStatus = {} as Record<OrderStatus, number>;
    for (const status of Object.values(OrderStatus)) byStatus[status] = 0;
    const rows = await this.orders
      .createQueryBuilder('o')
      .select('o.status', 'status')
      .addSelect('COUNT(1)', 'cnt')
      .groupBy('o.status')
      .getRawMany<{ status: OrderStatus; cnt: string }>();
    let total = 0;
    for (const row of rows) {
      const n = Number(row.cnt);
      byStatus[row.status] = n;
      total += n;
    }
    return { total, byStatus };
  }
}
