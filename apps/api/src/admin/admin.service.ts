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
      restaurantTotal,
      openRestaurants,
      orderTotal,
      pending,
      confirmed,
      preparing,
      delivering,
      completed,
      cancelled,
      recentUsers,
      recentRestaurants,
      recentOrders,
    ] = await Promise.all([
      this.users.count(),
      this.users.count({ where: { role: UserRole.CUSTOMER } }),
      this.users.count({ where: { role: UserRole.OWNER } }),
      this.users.count({ where: { role: UserRole.ADMIN } }),
      this.restaurants.count(),
      this.restaurants.count({ where: { isOpen: true } }),
      this.orders.count(),
      this.orders.count({ where: { status: OrderStatus.PENDING } }),
      this.orders.count({ where: { status: OrderStatus.CONFIRMED } }),
      this.orders.count({ where: { status: OrderStatus.PREPARING } }),
      this.orders.count({ where: { status: OrderStatus.DELIVERING } }),
      this.orders.count({ where: { status: OrderStatus.COMPLETED } }),
      this.orders.count({ where: { status: OrderStatus.CANCELLED } }),
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

    return {
      counts: {
        users: { total: userTotal, customer: customers, owner: owners, admin: admins },
        restaurants: { total: restaurantTotal, open: openRestaurants },
        orders: {
          total: orderTotal,
          pending,
          confirmed,
          preparing,
          delivering,
          completed,
          cancelled,
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
}
