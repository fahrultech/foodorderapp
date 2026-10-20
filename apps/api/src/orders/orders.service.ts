import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  DEFAULT_PAGE_SIZE,
  ListMyOrdersDto,
  MAX_PAGE_SIZE,
} from './dto/list-my-orders.dto';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { isUuid } from '../common/uuid';

const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.DELIVERING, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERING]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly menu: MenuService,
    private readonly restaurants: RestaurantsService,
  ) {}

  private generateCode(): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return `FO-${out}`;
  }

  async create(dto: CreateOrderDto, userId?: string) {
    const restaurant = await this.restaurants.findOne(dto.restaurantId);
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const menuItems = await this.menu.findByIds(dto.items.map((i) => i.menuItemId));
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    let subtotal = 0;
    const items: Partial<OrderItem>[] = [];
    for (const line of dto.items) {
      const quantity = Math.floor(line.quantity);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 50) {
        throw new BadRequestException(`Invalid quantity for ${line.menuItemId}`);
      }
      const m = byId.get(line.menuItemId);
      if (!m || !m.isAvailable) {
        throw new BadRequestException(`Item ${line.menuItemId} is not available`);
      }
      if (m.restaurantId !== dto.restaurantId) {
        throw new BadRequestException(`Item ${m.id} does not belong to this restaurant`);
      }
      subtotal += m.priceCents * quantity;
      items.push({
        menuItemId: m.id,
        name: m.name,
        unitPriceCents: m.priceCents,
        quantity,
      });
    }

    if (subtotal < restaurant.minOrderCents) {
      throw new BadRequestException(
        `Order below minimum of ${(restaurant.minOrderCents / 100).toFixed(2)}`,
      );
    }

    const order = this.orders.create({
      code: this.generateCode(),
      restaurantId: dto.restaurantId,
      userId: userId ?? null,
      customerName: dto.customerName,
      contactPhone: dto.contactPhone,
      deliveryAddress: dto.deliveryAddress,
      note: dto.note,
      subtotalCents: subtotal,
      deliveryFeeCents: restaurant.deliveryFeeCents,
      totalCents: subtotal + restaurant.deliveryFeeCents,
      items,
    });
    const saved = await this.orders.save(order);
    return this.findOne(saved.id);
  }

  async findOne(id: string) {
    if (!isUuid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id },
      relations: { items: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Paginated, status-filterable order history for the authenticated customer.
   * Returns the same { items, total, page, limit } envelope restaurants.findAll uses.
   */
  async findMine(userId: string, q: ListMyOrdersDto = {}) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.limit) || DEFAULT_PAGE_SIZE));

    const where: FindOptionsWhere<Order> = { userId };
    if (q.status) where.status = q.status;

    const [items, total] = await this.orders.findAndCount({
      where,
      // items included so the web order-history page can render a per-order
      // line summary without an extra request per card.
      relations: { restaurant: true, items: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  /**
   * Customer-initiated cancellation. The customer may only cancel their own
   * order, and only while the status machine still allows ->CANCELLED
   * (pending/confirmed/preparing). Once the food is out for delivery the
   * customer has no self-service cancel — the restaurant/admin path stands.
   */
  async cancel(id: string, userId: string) {
    if (!isUuid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({
      where: { id },
      relations: { restaurant: true, items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.userId !== userId) {
      // Same 404 as a missing order — do not leak that it exists under another user.
      throw new NotFoundException('Order not found');
    }
    if (!STATUS_FLOW[order.status].includes(OrderStatus.CANCELLED)) {
      throw new BadRequestException(
        `Order can no longer be cancelled (status: ${order.status})`,
      );
    }
    order.status = OrderStatus.CANCELLED;
    return this.orders.save(order);
  }

  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.findOne(id);
    if (!STATUS_FLOW[order.status].includes(status)) {
      throw new BadRequestException(
        `Cannot move order from ${order.status} to ${status}`,
      );
    }
    order.status = status;
    return this.orders.save(order);
  }

  nextStatuses(id: string) {
    return this.findOne(id).then((o) => STATUS_FLOW[o.status]);
  }
}
