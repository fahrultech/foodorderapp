import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Restaurant } from './restaurant.entity';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';
import { UserRole } from '../users/user.entity';

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

  /** Slugify a name and make it unique by appending -2, -3… on collision. */
  async uniqueSlug(base: string): Promise<string> {
    const cleaned =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'restaurant';
    let candidate = cleaned;
    let n = 1;
    // loop until free; realistically 1-2 iterations
    while (await this.repo.findOne({ where: { slug: candidate }, select: { id: true } })) {
      n += 1;
      candidate = `${cleaned}-${n}`;
    }
    return candidate;
  }

  async createForOwner(
    ownerId: string,
    dto: CreateRestaurantDto,
  ): Promise<Restaurant> {
    const slug = dto.slug ? await this.uniqueSlug(dto.slug) : await this.uniqueSlug(dto.name);
    const restaurant = this.repo.create({
      slug,
      name: dto.name,
      description: dto.description ?? null as any,
      cuisine: dto.cuisine ?? null as any,
      city: dto.city ?? null as any,
      address: dto.address ?? null as any,
      imageUrl: dto.imageUrl ?? null as any,
      deliveryFeeCents: dto.deliveryFeeCents ?? 0,
      minOrderCents: dto.minOrderCents ?? 0,
      avgPrepMinutes: dto.avgPrepMinutes ?? 30,
      ownerId,
    });
    return this.repo.save(restaurant);
  }

  async findOwned(ownerId: string): Promise<Restaurant[]> {
    return this.repo.find({ where: { ownerId }, order: { createdAt: 'DESC' } });
  }

  /** Owner-or-admin update: an actor may only touch restaurants they own (admins bypass). */
  async updateOwned(
    id: string,
    actor: { sub: string; role: UserRole },
    dto: UpdateRestaurantDto,
  ): Promise<Restaurant> {
    const restaurant = await this.repo.findOne({ where: { id } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (actor.role !== UserRole.ADMIN && restaurant.ownerId !== actor.sub) {
      throw new ForbiddenException('You do not own this restaurant');
    }
    const patch: Partial<Restaurant> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description as any;
    if (dto.cuisine !== undefined) patch.cuisine = dto.cuisine as any;
    if (dto.city !== undefined) patch.city = dto.city as any;
    if (dto.address !== undefined) patch.address = dto.address as any;
    if (dto.imageUrl !== undefined) patch.imageUrl = dto.imageUrl as any;
    if (dto.deliveryFeeCents !== undefined) patch.deliveryFeeCents = dto.deliveryFeeCents;
    if (dto.minOrderCents !== undefined) patch.minOrderCents = dto.minOrderCents;
    if (dto.avgPrepMinutes !== undefined) patch.avgPrepMinutes = dto.avgPrepMinutes;
    if (dto.isOpen !== undefined) patch.isOpen = dto.isOpen;
    Object.assign(restaurant, patch);
    return this.repo.save(restaurant);
  }
}
