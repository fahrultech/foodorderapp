import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Restaurant } from './restaurant.entity';
import { RestaurantHours } from './restaurant-hours.entity';
import { CreateRestaurantDto, UpdateRestaurantDto } from './dto/restaurant.dto';
import { UpdateRestaurantHoursDto } from './dto/restaurant-hours.dto';
import { isOpenAt, isValidTimeZone, serverTimeZone, TIME_RE } from './open-hours';
import { escapeLike } from '../common/like-escape';
import { UserRole } from '../users/user.entity';
import { isUuid } from '../common/uuid';
import { City } from '../cities/city.entity';
import { MenuService } from '../menu/menu.service';

export interface RestaurantQuery {
  search?: string;
  cuisine?: string;
  city?: string;
  sort?: 'rating' | 'deliveryFee' | 'newest';
  page?: number;
  limit?: number;
}

/** Shape returned by replaceHours (also the swagger view model). */
export interface RestaurantHoursView {
  restaurantId: string;
  timeZone: string | null;
  days: RestaurantHours[];
  isOpenNow: boolean;
}

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly repo: Repository<Restaurant>,
    @InjectRepository(City)
    private readonly cityRepo: Repository<City>,
    // Session 66: the storefront's dish rows need their option groups —
    // embedded through MenuService's single-IN attach so GET /restaurants/:id
    // and GET /restaurants/:id/menu ship one identical shape. @Optional keeps
    // the unit harness (constructed without it) valid.
    @Optional()
    private readonly menu?: MenuService,
    // Session 68: weekly open-hours schedule + derived `isOpenNow`, attached
    // through ONE batched IN query (no N+1). Same @Optional contract.
    @Optional()
    @InjectRepository(RestaurantHours)
    private readonly hours?: Repository<RestaurantHours>,
  ) {}

  /**
   * Batch-attach `hours` + `isOpenNow` to restaurant rows.
   * Rule (ARCHITECTURE): rows exist -> schedule-derived; NO rows -> the
   * legacy manual `isOpen` column. `now` is injectable for deterministic
   * unit tests.
   */
  async attachHours<T extends Restaurant>(
    rows: T[],
    now: Date = new Date(),
  ): Promise<T[]> {
    if (!rows.length || !this.hours) return rows;
    const found = await this.hours.find({
      where: { restaurantId: In(rows.map((r) => r.id)) },
      order: { dayOfWeek: 'ASC' },
    });
    const byRestaurant = new Map<string, RestaurantHours[]>();
    for (const h of found) {
      const list = byRestaurant.get(h.restaurantId) ?? [];
      list.push(h);
      byRestaurant.set(h.restaurantId, list);
    }
    for (const r of rows) {
      const schedule = byRestaurant.get(r.id) ?? [];
      (r as any).hours = schedule;
      (r as any).isOpenNow =
        isOpenAt(schedule, now, r.timeZone ?? serverTimeZone()) ?? r.isOpen;
    }
    return rows;
  }

  async findAll(q: RestaurantQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const qb = this.repo.createQueryBuilder('r');

    if (q.search) {
      // Session 79 perf sweep: `LOWER(col) LIKE '%term%'` is a function call
      // on the column - never indexable. Plain `col ILIKE` has IDENTICAL
      // case-insensitive substring semantics and pg_trgm's gin_trgm_ops
      // indexes serve it directly (name: session 69; cuisine: this session).
      // Patterns under 3 chars can't yield trigrams, so Postgres honestly
      // falls back to a scan there — same rows, same order.
      // Metacharacters are escaped, matching /api/search (session 69):
      // what the user types is what must match, not wildcards.
      const s = `%${escapeLike(q.search.toLowerCase())}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where('r.name ILIKE :s', { s })
            .orWhere('r.cuisine ILIKE :s', { s });
        }),
      );
    }
    if (q.cuisine) qb.andWhere('LOWER(r.cuisine) = :cuisine', { cuisine: q.cuisine.toLowerCase() });
    if (q.city) {
      // Session 79: EXISTS instead of `leftJoin('r.cityEntity')`. With a
      // join + skip/take, TypeORM switches to a DISTINCT-ids two-query
      // strategy (probe: 4 statements vs the constant 3); the semi-join
      // keeps the list a single LIMIT/OFFSET query with identical rows —
      // a city row matches by slug/name, a NULL-cityId row by the legacy
      // name snapshot.
      qb.andWhere(
        `(EXISTS (SELECT 1 FROM cities c WHERE c.id = r."cityId" AND (LOWER(c.slug) = :city OR LOWER(c.name) = :city)) OR (r."cityId" IS NULL AND LOWER(r.city) = :city))`,
        { city: q.city.toLowerCase() },
      );
    }

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
    // ONE batched hours query for the whole page (the batched-IN contract
    // the option-groups attach set in session 65/66).
    return { items: await this.attachHours(items), total, page, limit };
  }

  async findOne(id: string) {
    if (!isUuid(id)) return null;
    const restaurant = await this.repo.findOne({
      where: { id },
      relations: { menuItems: true },
    });
    if (restaurant?.menuItems?.length && this.menu) {
      restaurant.menuItems = await this.menu.attachOptionGroups(restaurant.menuItems);
    }
    if (restaurant) await this.attachHours([restaurant]);
    return restaurant;
  }

  /**
   * Distinct non-empty cuisine names for the storefront filter chips
   * (session 79). This used to load EVERY restaurant row as a FULL entity
   * (21 columns, ORDER BY name) and de-duplicate in Node — a per-request
   * allocation that grows with the table (EXPLAIN at 9k rows: width 331
   * scan + 3.1 MB quicksort) to answer a ~10-value question. One
   * SELECT DISTINCT does it column-only, index-free but 40x narrower, and
   * the sort happens where it belongs.
   */
  async distinctCuisines(): Promise<string[]> {
    const rows = await this.repo
      .createQueryBuilder('r')
      .select('DISTINCT r.cuisine', 'cuisine')
      .where('r.cuisine IS NOT NULL')
      .andWhere("TRIM(r.cuisine) <> ''")
      .orderBy('r.cuisine', 'ASC')
      .getRawMany();
    return rows.map((row: { cuisine: string }) => row.cuisine);
  }

  /**
   * Owner-or-admin WEEKLY SCHEDULE REPLACEMENT (PUT semantics). Mirrors
   * `updateOwned`'s ownership rules. Guards that class-validator cannot
   * express: duplicate dayOfWeek, opensAt === closesAt (empty window — all-day
   * is 00:00-23:59), bogus IANA zone. An empty `days` clears the schedule,
   * handing the open status back to the legacy manual `isOpen` toggle.
   */
  async replaceHours(
    id: string,
    actor: { sub: string; role: UserRole },
    dto: UpdateRestaurantHoursDto,
  ): Promise<RestaurantHoursView> {
    if (!isUuid(id)) throw new NotFoundException('Restaurant not found');
    if (!this.hours) throw new Error('RestaurantsModule wiring missing');
    const restaurant = await this.repo.findOne({ where: { id } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (actor.role !== UserRole.ADMIN && restaurant.ownerId !== actor.sub) {
      throw new ForbiddenException('You do not own this restaurant');
    }

    const days = dto.days ?? [];
    const seen = new Set<number>();
    for (const d of days) {
      if (seen.has(d.dayOfWeek)) {
        throw new BadRequestException(`Duplicate dayOfWeek ${d.dayOfWeek}`);
      }
      seen.add(d.dayOfWeek);
      if (d.opensAt === d.closesAt) {
        throw new BadRequestException(
          'opensAt and closesAt must differ (all-day is 00:00-23:59)',
        );
      }
      if (!TIME_RE.test(d.opensAt) || !TIME_RE.test(d.closesAt)) {
        throw new BadRequestException('Times must be HH:MM in 24h form');
      }
    }
    if (
      dto.timeZone !== undefined &&
      dto.timeZone !== null &&
      !isValidTimeZone(dto.timeZone)
    ) {
      throw new BadRequestException('timeZone must be a valid IANA zone');
    }

    // Full replace: wipe then insert. No transaction yet — matches the
    // codebase's pre-"Unit-of-work" norm; a single-owner route tolerates it.
    await this.hours.delete({ restaurantId: id });
    const rows = days.length
      ? await this.hours.save(
          days.map((d) =>
            this.hours!.create({
              restaurantId: id,
              dayOfWeek: d.dayOfWeek,
              opensAt: d.opensAt,
              closesAt: d.closesAt,
            }),
          ),
        )
      : [];
    if (dto.timeZone !== undefined) {
      restaurant.timeZone = dto.timeZone;
      await this.repo.save(restaurant);
    }
    const sorted = [...rows].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
    return {
      restaurantId: id,
      timeZone: restaurant.timeZone,
      days: sorted,
      isOpenNow:
        isOpenAt(sorted, new Date(), restaurant.timeZone ?? serverTimeZone()) ??
        restaurant.isOpen,
    };
  }

  /** Slugify a name and make it unique by appending -2, -3, etc. on collision. */
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

  /**
   * MAP-PIN PARTNER GUARD (session 70): a lone latitude or longitude is
   * useless geometry, class-validator cannot express it cross-field, and the
   * DB CHECKs would happily accept a half pair — so the service is the single
   * place that decides. Update semantics: the pair is replaced CLEANLY —
   * either BOTH coordinates (set/move the pin) or BOTH explicit `null`
   * (clear it). Any half pair (one value + one null/missing) is a 400.
   */
  private static resolveCoordinatePair(
    dto: { latitude?: number | null; longitude?: number | null },
    forUpdate: boolean,
  ): { latitude: number | null; longitude: number | null } {
    const lat = dto.latitude ?? null;
    const lng = dto.longitude ?? null;
    if ((lat === null) !== (lng === null)) {
      throw new BadRequestException(
        forUpdate
          ? 'latitude and longitude must be provided together (both null clears the map pin)'
          : 'latitude and longitude must be provided together',
      );
    }
    return { latitude: lat, longitude: lng };
  }

  async createForOwner(
    ownerId: string,
    dto: CreateRestaurantDto,
  ): Promise<Restaurant> {
    const slug = dto.slug ? await this.uniqueSlug(dto.slug) : await this.uniqueSlug(dto.name);
    const city = dto.cityId
      ? await this.cityRepo.findOne({ where: { id: dto.cityId, isActive: true } })
      : null;
    if (dto.cityId && !city) throw new NotFoundException('City not found or inactive');
    const coordinates = RestaurantsService.resolveCoordinatePair(dto, false);
    const restaurant = this.repo.create({
      slug,
      name: dto.name,
      description: dto.description ?? null as any,
      cuisine: dto.cuisine ?? null as any,
      city: city?.name ?? dto.city ?? null as any,
      cityId: city?.id ?? null,
      address: dto.address ?? null as any,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      imageUrl: dto.imageUrl ?? null as any,
      deliveryFeeCents: dto.deliveryFeeCents ?? 0,
      minOrderCents: dto.minOrderCents ?? 0,
      avgPrepMinutes: dto.avgPrepMinutes ?? 30,
      ownerId,
    });
    return this.repo.save(restaurant);
  }

  async findOwned(ownerId: string): Promise<Restaurant[]> {
    const rows = await this.repo.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });
    return this.attachHours(rows);
  }

  /** Owner-or-admin update: an actor may only touch restaurants they own (admins bypass). */
  async updateOwned(
    id: string,
    actor: { sub: string; role: UserRole },
    dto: UpdateRestaurantDto,
  ): Promise<Restaurant> {
    if (!isUuid(id)) throw new NotFoundException('Restaurant not found');
    const restaurant = await this.repo.findOne({ where: { id } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (actor.role !== UserRole.ADMIN && restaurant.ownerId !== actor.sub) {
      throw new ForbiddenException('You do not own this restaurant');
    }
    const patch: Partial<Restaurant> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.description !== undefined) patch.description = dto.description as any;
    if (dto.cuisine !== undefined) patch.cuisine = dto.cuisine as any;
    if (dto.cityId !== undefined) {
      const city = await this.cityRepo.findOne({
        where: { id: dto.cityId, isActive: true },
      });
      if (!city) throw new NotFoundException('City not found or inactive');
      patch.cityId = city.id;
      patch.city = city.name;
    } else if (dto.city !== undefined) {
      patch.city = dto.city as any;
      patch.cityId = null;
    }
    if (dto.address !== undefined) patch.address = dto.address as any;
    if (dto.imageUrl !== undefined) patch.imageUrl = dto.imageUrl as any;
    if (dto.deliveryFeeCents !== undefined) patch.deliveryFeeCents = dto.deliveryFeeCents;
    if (dto.minOrderCents !== undefined) patch.minOrderCents = dto.minOrderCents;
    if (dto.avgPrepMinutes !== undefined) patch.avgPrepMinutes = dto.avgPrepMinutes;
    if (dto.isOpen !== undefined) patch.isOpen = dto.isOpen;
    if (dto.latitude !== undefined || dto.longitude !== undefined) {
      const coordinates = RestaurantsService.resolveCoordinatePair(dto, true);
      patch.latitude = coordinates.latitude;
      patch.longitude = coordinates.longitude;
    }
    Object.assign(restaurant, patch);
    return this.repo.save(restaurant);
  }
}
