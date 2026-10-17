import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MenuItem } from './menu-item.entity';

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(MenuItem) private readonly repo: Repository<MenuItem>,
  ) {}

  findByRestaurant(restaurantId: string) {
    return this.repo.find({
      where: { restaurantId },
      order: { category: 'ASC', name: 'ASC' },
    });
  }

  /** Fetch items by ids — used when pricing an order server-side. */
  async findByIds(ids: string[]) {
    const items = await this.repo.find({ where: { id: In(ids) } });
    if (items.length !== new Set(ids).size) {
      throw new NotFoundException('One or more menu items no longer exist');
    }
    return items;
  }
}
