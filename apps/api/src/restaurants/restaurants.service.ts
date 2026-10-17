import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Restaurant } from './restaurant.entity';

export interface RestaurantQuery {
  search?: string;
  cuisine?: string;
  city?: string;
  sort?: 'rating' | 'deliveryFee' | 'newest';
  page?: number;
  limit?: number;
}

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly repo: Repository<Restaurant>,
  ) {}

  async findAll(q: RestaurantQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const qb = this.repo.createQueryBuilder('r');

    if (q.search) {
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('LOWER(r.name) LIKE :s', { s: `%${q.search.toLowerCase()}%` })
            .orWhere('LOWER(r.cuisine) LIKE :s', { s: `%${q.search.toLowerCase()}%` });
        }),
      );
    }
    if (q.cuisine) qb.andWhere('LOWER(r.cuisine) = :cuisine', { cuisine: q.cuisine.toLowerCase() });
    if (q.city) qb.andWhere('LOWER(r.city) = :city', { city: q.city.toLowerCase() });

    switch (q.sort) {
      case 'deliveryFee':
        qb.orderBy('r.deliveryFeeCents', 'ASC');
        break;
      case 'newest':
        qb.orderBy('r.createdAt', 'DESC');
        break;
      default:
        qb.orderBy('r.rating', 'DESC');
    }

    const [items, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { items, total, page, limit };
  }

  async findOne(id: string) {
    return this.repo.findOne({
      where: { id },
      relations: { menuItems: true },
    });
  }

  async findRestaurants() {
    return this.repo.find({ order: { name: 'ASC' } });
  }
}
