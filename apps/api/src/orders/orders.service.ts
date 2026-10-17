import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { MenuService } from '../menu/menu.service';
import { RestaurantsService } from '../restaurants/restaurants.service';

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
    const order = await this.orders.findOne({
      where: { id },
      relations: { items: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  async findMine(userId: string) {
    return this.orders.find({
      where: { userId },
      relations: { restaurant: true },
      order: { createdAt: 'DESC' },
      take: 50,
    });
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
