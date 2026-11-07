import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { RestaurantsService } from '../restaurants/restaurants.service';

/** Default + hard per-side cap (the DTO also validates, this is the last gate). */
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 25;

/**
 * Escape ILIKE metacharacters. The backslash is the default LIKE escape
 * character; without this, a query like `50%` or `a_b` would match wildcards
 * instead of the literal text the user typed.
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Relevance = trigram similarity of the whole name plus the best WORD
 * word similarity across the searchable fields (`word_similarity(query, text)` —
 * query first). Ranking never gates a match; the WHERE clause does.
 * NOTE on operator ORDER: `%<` no longer exists (renamed `<%` in PG13), and
 * `a <% b` evaluates word_similarity(a, b) >= pg_trgm.word_similarity_threshold
 * (0.6 by default) — the QUERY must sit on the LEFT; the planner commutates
 * `query <% column` into the indexable `column %> query` form (verified via
 * EXPLAIN, DEVLOG session 69). `%` is the symmetric full-string operator at
 * similarity_threshold 0.3.
 *
 * Positional $1=query $2=escaped-like $3=limit: TypeORM's Postgres query
 * runner passes params straight through to `pg`, so an array of positionals
 * is the only convention that is BOTH type-safe and driver-supported.
 * The SAME $1 is reused by every trigram operator — pg maps each occurrence.
 */
const RESTAURANTS_SQL = `
  SELECT
    id, slug, name, description, cuisine, city, "cityId", address, "imageUrl",
    rating, "deliveryFeeCents", "minOrderCents", "avgPrepMinutes",
    "isOpen", "timeZone",
    GREATEST(
      similarity(name, $1),
      word_similarity($1, name),
      word_similarity($1, COALESCE(description, '')),
      word_similarity($1, COALESCE(cuisine, ''))
    ) AS relevance
  FROM restaurants
  WHERE (
    name % $1 OR $1 <% name
    OR cuisine % $1 OR $1 <% cuisine
    OR description % $1 OR $1 <% description
    OR name ILIKE $2 OR cuisine ILIKE $2 OR description ILIKE $2
  )
  ORDER BY relevance DESC, rating DESC, name ASC
  LIMIT $3
`;

const DISHES_SQL = `
  SELECT
    m.id, m.name, m.description, m."priceCents", m.category, m."imageUrl",
    m."restaurantId", r.slug AS "restaurantSlug", r.name AS "restaurantName",
    r.cuisine AS "restaurantCuisine",
    GREATEST(
      similarity(m.name, $1),
      word_similarity($1, m.name),
      word_similarity($1, COALESCE(m.description, ''))
    ) AS relevance
  FROM menu_items m
  JOIN restaurants r ON r.id = m."restaurantId"
  WHERE m."isAvailable" AND (
    m.name % $1 OR $1 <% m.name
    OR m.description % $1 OR $1 <% m.description
    OR m.name ILIKE $2 OR m.description ILIKE $2
  )
  ORDER BY relevance DESC, m."priceCents" ASC, m.name ASC
  LIMIT $3
`;

export interface SearchRestaurantResult {
  id: string;
  slug: string;
  name: string;
  cuisine: string | null;
  city: string | null;
  imageUrl: string | null;
  rating: number;
  deliveryFeeCents: number;
  minOrderCents: number;
  avgPrepMinutes: number;
  /** Legacy manual toggle — kept so the storefront can show both signals. */
  isOpen: boolean;
  timeZone: string | null;
  /** Embedded by RestaurantsService.attachHours (batched, no N+1). */
  hours?: unknown[];
  isOpenNow?: boolean;
  relevance: number;
}

export interface SearchDishResult {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  category: string | null;
  imageUrl: string | null;
  restaurantId: string;
  restaurant: { id: string; slug: string; name: string; cuisine: string | null };
  relevance: number;
}

@Injectable()
export class SearchService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurants: Repository<Restaurant>,
    @InjectRepository(MenuItem)
    private readonly menuItems: Repository<MenuItem>,
    // Shared hours derivation (session 68): search results must agree with
    // the storefront list, never recompute open-ness from a second clock.
    private readonly restaurantsService: RestaurantsService,
  ) {}

  async search(q: string, rawLimit?: number) {
    const query = (q ?? '').trim();
    if (!query) throw new BadRequestException('q must not be empty');
    // ONLY an absent/unparseable limit falls back to the default; a present
    // 0/negative is clamped to 1, never silently re-read as "unset".
    const raw = Number(rawLimit);
    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      Math.max(1, rawLimit === undefined || rawLimit === null || Number.isNaN(raw) ? SEARCH_DEFAULT_LIMIT : raw),
    );
    const like = `%${escapeLike(query)}%`;

    const [restaurantRows, dishRows] = await Promise.all([
      this.restaurants.query(RESTAURANTS_SQL, [query, like, limit]),
      this.menuItems.query(DISHES_SQL, [query, like, limit]),
    ]);

    const restaurants: SearchRestaurantResult[] = restaurantRows.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      cuisine: r.cuisine ?? null,
      city: r.city ?? null,
      imageUrl: r.imageUrl ?? null,
      // pg returns NUMERIC as string; the response contract says number.
      rating: Number(r.rating),
      deliveryFeeCents: Number(r.deliveryFeeCents),
      minOrderCents: Number(r.minOrderCents),
      avgPrepMinutes: Number(r.avgPrepMinutes),
      isOpen: Boolean(r.isOpen),
      timeZone: r.timeZone ?? null,
      relevance: Number(r.relevance),
    }));
    // Batched hours + derived isOpenNow, the same contract as /restaurants.
    await this.restaurantsService.attachHours(restaurants as unknown as Restaurant[]);

    const dishes: SearchDishResult[] = dishRows.map((m: any) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      priceCents: Number(m.priceCents),
      category: m.category ?? null,
      imageUrl: m.imageUrl ?? null,
      restaurantId: m.restaurantId,
      restaurant: {
        id: m.restaurantId,
        slug: m.restaurantSlug,
        name: m.restaurantName,
        cuisine: m.restaurantCuisine ?? null,
      },
      relevance: Number(m.relevance),
    }));

    return { query, limit, restaurants, dishes };
  }
}
