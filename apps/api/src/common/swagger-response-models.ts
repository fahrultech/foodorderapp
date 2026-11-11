import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { OrderStatus } from '../orders/order.entity';
import { UserRole } from '../users/user.entity';
import { PromoDiscountType } from '../promos/promo-code.entity';
import { PaymentStatus } from '../payments/payment.entity';

/**
 * Typed RESPONSE models for the OpenAPI document (roadmap Phase 4 "Swagger
 * response schemas"). Every class here mirrors what a service ACTUALLY returns
 * on the wire — verified against the service code, not guessed. Conventions
 * carried over from the request-DTO pass (@nestjs/swagger 11 quirks):
 * - Dates serialize as ISO strings -> explicit `string` + `date-time` format.
 * - `string | null` unions MUST declare `type: 'string', nullable: true`
 *   (plain union infers `Object`).
 * - Money/quantities are integers — declare `type: 'integer'` (plain Number
 *   emits `number`).
 * The shared spec (swagger.spec.ts) asserts operations reference these models
 * and that the envelope/nullable/integer contracts stay intact.
 */

// ---------------------------------------------------------------------------
// Error envelope — every non-2xx answer from ErrorFormatFilter looks exactly
// like this, whatever the status.
// ---------------------------------------------------------------------------

export class ErrorBodyResponse {
  @ApiProperty({
    description:
      'Stable machine code. Defaults derive from the status (BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, TOO_MANY_REQUESTS, INTERNAL_SERVER_ERROR); domain exceptions add specific codes (e.g. MIN_ORDER_NOT_MET).',
    example: 'NOT_FOUND',
  })
  code: string;

  @ApiProperty({ description: 'Human-readable message.', example: 'Order not found' })
  message: string;

  @ApiProperty({
    nullable: true,
    description:
      'Machine-readable extras: string[] of constraint messages on validation failures, an object for specific domain codes, otherwise null.',
  })
  details: Record<string, unknown> | unknown[] | null;
}

export class ErrorResponse {
  @ApiProperty({ type: () => ErrorBodyResponse })
  error: ErrorBodyResponse;
}

/** `@ApiError(404, 'Unknown or foreign order id')` — the envelope under any status. */
export function ApiError(status: number, description: string) {
  return ApiResponse({ status, type: ErrorResponse, description });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export class PushConfigResponse {
  @ApiProperty({ description: 'True only when the complete VAPID configuration is loaded.' })
  enabled: boolean;

  @ApiProperty({ type: 'string', nullable: true, description: 'Public VAPID key for PushManager.subscribe; null while disabled.' })
  publicKey: string | null;
}

export class PushSubscriptionResponse {
  @ApiProperty({ example: true })
  subscribed: boolean;
}

export class PushUnsubscribeResponse {
  @ApiProperty({ description: 'Whether a row belonging to the current user was removed.' })
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export class HealthResponse {
  @ApiProperty({ enum: ['ok', 'degraded'], description: 'ok while `SELECT 1` succeeds, degraded otherwise.' })
  status: string;

  @ApiProperty({ enum: ['up', 'down'] })
  db: string;

  @ApiProperty({ type: 'number', description: 'Process uptime, seconds.' })
  uptime: number;

  @ApiProperty({ type: 'string', format: 'date-time' })
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Users / auth
// ---------------------------------------------------------------------------

export class SafeUserResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'diner@example.com' })
  email: string;

  @ApiProperty({ example: 'Dana Diner' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  phone: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  address: string | null;

  @ApiProperty({ enum: UserRole })
  role: UserRole;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class SessionResponse {
  @ApiProperty({ description: 'Short-lived JWT; send as `Authorization: Bearer <token>`.', type: 'string' })
  access_token: string;

  @ApiProperty({ description: 'Opaque 256-bit refresh token (base64url). Usable exactly once — every refresh rotates it.', type: 'string' })
  refresh_token: string;

  @ApiProperty({ example: 'Bearer' })
  token_type: string;

  @ApiProperty({ type: 'integer', description: 'Access-token lifetime in seconds.' })
  expires_in: number;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'When the refresh token stops being accepted.' })
  refresh_expires_at: string;

  @ApiProperty({ type: () => SafeUserResponse })
  user: SafeUserResponse;
}

export class LogoutResponse {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ type: 'integer', description: 'How many refresh sessions were revoked.' })
  revoked_sessions: number;
}

export class AccountFavoriteRestaurantResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

export class AccountFavoriteMenuItemResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: () => AccountFavoriteRestaurantResponse, nullable: true })
  restaurant: AccountFavoriteRestaurantResponse | null;
}

export class AccountFavoriteExportResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  menuItemId: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: () => AccountFavoriteMenuItemResponse, nullable: true })
  menuItem: AccountFavoriteMenuItemResponse | null;
}

export class AccountReviewExportResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  orderId: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5 })
  rating: number;

  @ApiProperty({ type: 'string', nullable: true })
  comment: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class AccountSessionExportResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  expiresAt: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  revokedAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;
}

export class AccountPushSubscriptionExportResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uri' })
  endpoint: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class AccountDeleteResponse {
  @ApiProperty({ example: true })
  deleted: boolean;

  @ApiProperty({ type: 'integer' })
  anonymizedOrders: number;

  @ApiProperty({ type: 'integer' })
  detachedRestaurants: number;

  @ApiProperty({ type: 'integer' })
  unassignedOrders: number;
}

// ---------------------------------------------------------------------------
// Restaurants & menu (wire = TypeORM entity JSON; unloaded relations absent)
// ---------------------------------------------------------------------------

export class CityResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'jakarta' })
  slug: string;

  @ApiProperty({ example: 'Jakarta' })
  name: string;

  @ApiProperty({ example: true, description: 'Always true on the public active-city endpoint.' })
  isActive: boolean;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

/** One weekly open-hours window (Phase 5 "Restaurant open hours"). */
export class RestaurantHoursResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 6,
    description: '0 = Sunday ... 6 = Saturday (JS getDay convention).',
  })
  dayOfWeek: number;

  @ApiProperty({ pattern: '([01]\\d|2[0-3]):[0-5]\\d', example: '08:00', description: 'Window start (inclusive), HH:MM 24h.' })
  opensAt: string;

  @ApiProperty({ pattern: '([01]\\d|2[0-3]):[0-5]\\d', example: '22:00', description: 'Window end (exclusive), HH:MM 24h; <= opensAt wraps past midnight.' })
  closesAt: string;
}

/** Fresh view returned by the owner schedule-replacement route. */
export class RestaurantHoursViewResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'IANA zone; null = server-local.' })
  timeZone: string | null;

  @ApiProperty({ type: [RestaurantHoursResponse], description: 'The stored schedule, sorted by dayOfWeek.' })
  days: RestaurantHoursResponse[];

  @ApiProperty({ description: 'Derived open status at request time.' })
  isOpenNow: boolean;
}

export class RestaurantResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Owning user id; null for platform-seeded restaurants.',
  })
  ownerId: string | null;

  @ApiProperty({ example: 'warung-budi' })
  slug: string;

  @ApiProperty({ example: 'Warung Budi' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'Indonesian' })
  cuisine: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'Jakarta' })
  city: string | null;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Registry city id used for multi-city scoping.',
  })
  cityId: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  address: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  imageUrl: string | null;

  @ApiProperty({
    type: 'number',
    description:
      'Display rating (2 decimals). Seed value until the first review, then the server-recomputed average; never client-writable.',
    example: 4.75,
  })
  rating: number;

  @ApiProperty({ type: 'integer', description: 'Reviews feeding `rating`; 0 = none yet.' })
  ratingCount: number;

  @ApiProperty({ type: 'integer', description: 'Delivery fee in cents.' })
  deliveryFeeCents: number;

  @ApiProperty({ type: 'integer', description: 'Minimum order subtotal in cents.' })
  minOrderCents: number;

  @ApiProperty({ type: 'integer', description: 'Average prep time, minutes.' })
  avgPrepMinutes: number;

  @ApiProperty({ description: 'LEGACY manual toggle. Derived `isOpenNow` takes over once a weekly open-hours schedule has rows.' })
  isOpen: boolean;

  @ApiProperty({
    type: 'number',
    nullable: true,
    minimum: -90,
    maximum: 90,
    description: 'Map pin (WGS84 decimal degrees); null = restaurant is off the storefront map.',
  })
  latitude: number | null;

  @ApiProperty({
    type: 'number',
    nullable: true,
    minimum: -180,
    maximum: 180,
    description: 'Map pin (WGS84 decimal degrees); null = restaurant is off the storefront map.',
  })
  longitude: number | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    maxLength: 64,
    example: 'Asia/Jakarta',
    description: 'IANA zone the open-hours schedule is interpreted in; null = server-local.',
  })
  timeZone: string | null;

  @ApiPropertyOptional({
    type: [RestaurantHoursResponse],
    description: 'Weekly open-hours schedule. Attached on storefront reads (list/detail/mine); omitted on plain entity writes.',
  })
  hours?: RestaurantHoursResponse[];

  @ApiPropertyOptional({
    description:
      'Auto open status: derived from `hours` when the schedule has rows, else the legacy manual `isOpen` column. Attached wherever `hours` is.',
  })
  isOpenNow?: boolean;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class MenuOptionChoiceResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid', description: 'Owning option group.' })
  groupId: string;

  @ApiProperty({ example: 'Large' })
  name: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Extra cents on top of the dish base price.' })
  priceDeltaCents: number;

  @ApiProperty({ type: 'integer', description: 'Display order inside the group.' })
  position: number;
}

export class MenuOptionGroupResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid', description: 'Dish this group belongs to.' })
  menuItemId: string;

  @ApiProperty({ example: 'Size' })
  name: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Selections an order line MUST include (0 = optional group).' })
  minChoices: number;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'Selections an order line MAY include.' })
  maxChoices: number;

  @ApiProperty({ type: 'integer', description: 'Display order on the dish.' })
  position: number;

  @ApiPropertyOptional({
    type: [MenuOptionChoiceResponse],
    description: 'Loaded on public menu reads and group mutations; omitted on choice-scoped routes.',
  })
  choices?: MenuOptionChoiceResponse[];
}

export class MenuItemResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Nasi Goreng Spesial' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ type: 'integer', description: 'Price in cents.' })
  priceCents: number;

  @ApiProperty({ type: 'string', nullable: true, example: 'Mains' })
  category: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  imageUrl: string | null;

  @ApiProperty({ description: 'false = sold out; unavailable dishes cannot be ordered.' })
  isAvailable: boolean;

  @ApiProperty({ type: 'integer', description: 'Prep time, minutes.' })
  prepMinutes: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    nullable: true,
    description: 'Sellable units remaining (null = unlimited). Order create decrements it atomically.',
  })
  stock: number | null;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;

  @ApiPropertyOptional({
    type: [MenuOptionGroupResponse],
    description: 'Option groups with their choices. Attached on the public menu read (GET /restaurants/{id}/menu) — empty array when the dish has none; omitted on owner mutation responses.',
  })
  optionGroups?: MenuOptionGroupResponse[];
}

export class MenuImageUploadResponse {
  @ApiProperty({ type: 'string', format: 'uri', description: 'Five-minute presigned PUT URL.' })
  uploadUrl: string;

  @ApiProperty({ type: 'string', format: 'uri', description: 'Public URL to save on the dish after the PUT succeeds.' })
  imageUrl: string;

  @ApiProperty({ example: 'menu-items/33333333-3333-4333-8333-333333333333/uuid.webp' })
  objectKey: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'Content-Type': 'image/webp' },
  })
  requiredHeaders: Record<string, string>;

  @ApiProperty({ type: 'string', format: 'date-time' })
  expiresAt: string;
}

/** GET /restaurants/{id} additionally embeds the dish list (relation loaded). */
export class RestaurantWithMenuResponse extends RestaurantResponse {
  @ApiProperty({ type: () => [MenuItemResponse] })
  menuItems: MenuItemResponse[];
}

export class PaginatedRestaurantsResponse {
  @ApiProperty({ type: () => [RestaurantResponse] })
  items: RestaurantResponse[];

  @ApiProperty({ type: 'integer', description: 'Total rows matching the filter (all pages).' })
  total: number;

  @ApiProperty({ type: 'integer' })
  page: number;

  @ApiProperty({ type: 'integer' })
  limit: number;
}

// ---------------------------------------------------------------------------
// Search (public fuzzy storefront search, pg_trgm)
// ---------------------------------------------------------------------------

/** Restaurant hit from GET /search — a SLIM projection plus the shared
 *  hours derivation and the server-side relevance score. */
export class SearchRestaurantResultResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'warung-budi' })
  slug: string;

  @ApiProperty({ example: 'Warung Budi' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'Indonesian' })
  cuisine: string | null;

  @ApiProperty({ type: 'string', nullable: true, example: 'Jakarta' })
  city: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  imageUrl: string | null;

  @ApiProperty({ type: 'number', example: 4.75 })
  rating: number;

  @ApiProperty({ type: 'integer', description: 'Delivery fee in cents.' })
  deliveryFeeCents: number;

  @ApiProperty({ type: 'integer', description: 'Minimum order subtotal in cents.' })
  minOrderCents: number;

  @ApiProperty({ type: 'integer', description: 'Average prep time, minutes.' })
  avgPrepMinutes: number;

  @ApiProperty({ description: 'LEGACY manual toggle — `isOpenNow` is the one to trust.' })
  isOpen: boolean;

  @ApiProperty({ type: 'string', nullable: true, maxLength: 64, example: 'Asia/Jakarta' })
  timeZone: string | null;

  @ApiProperty({
    type: [RestaurantHoursResponse],
    description: 'Weekly open-hours schedule, batched from the same derivation as GET /restaurants.',
  })
  hours: RestaurantHoursResponse[];

  @ApiProperty({ description: 'Server-derived open status at request time (never recomputed client-side).' })
  isOpenNow: boolean;

  @ApiProperty({
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Trigram relevance (0..1): name similarity / best word similarity across name, description, cuisine.',
    example: 0.64,
  })
  relevance: number;
}

/** The owning-restaurant brief embedded on each dish hit. */
export class SearchRestaurantBriefResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'warung-budi' })
  slug: string;

  @ApiProperty({ example: 'Warung Budi' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true, example: 'Indonesian' })
  cuisine: string | null;
}

/** Dish hit from GET /search — only AVAILABLE items are ever returned. */
export class SearchDishResultResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Nasi Goreng' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ type: 'integer', description: 'Unit price in cents (integer cents, no floats).' })
  priceCents: number;

  @ApiProperty({ type: 'string', nullable: true, example: 'Mains' })
  category: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  imageUrl: string | null;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: () => SearchRestaurantBriefResponse })
  restaurant: SearchRestaurantBriefResponse;

  @ApiProperty({
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Trigram relevance (0..1) over the dish name and description.',
    example: 0.57,
  })
  relevance: number;
}

export class SearchResultsResponse {
  @ApiProperty({ description: 'The trimmed query actually executed.' })
  query: string;

  @ApiProperty({ type: 'integer', description: 'Effective per-side cap applied to both lists.' })
  limit: number;

  @ApiProperty({ type: () => [SearchRestaurantResultResponse] })
  restaurants: SearchRestaurantResultResponse[];

  @ApiProperty({ type: () => [SearchDishResultResponse] })
  dishes: SearchDishResultResponse[];
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export class OrderItemOptionSelectionResponse {
  @ApiProperty({ type: 'string', format: 'uuid', description: 'Option group id at order time (snapshot; may reference a since-deleted group).' })
  groupId: string;

  @ApiProperty({ example: 'Size', description: 'Group label snapshot.' })
  groupName: string;

  @ApiProperty({ type: 'string', format: 'uuid', description: 'Choice id at order time (snapshot).' })
  choiceId: string;

  @ApiProperty({ example: 'Large', description: 'Choice label snapshot.' })
  choiceName: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Cents folded into unitPriceCents for this choice.' })
  priceDeltaCents: number;
}

export class OrderItemResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  orderId: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Set null if the dish is later deleted (snapshot keeps the order readable).',
  })
  menuItemId: string | null;

  @ApiProperty({ description: 'Dish name at order time (snapshot).' })
  name: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 50 })
  quantity: number;

  @ApiProperty({ type: 'integer', description: 'Unit price in cents (snapshot; INCLUDES resolved menu-option deltas).' })
  unitPriceCents: number;

  @ApiProperty({
    type: [OrderItemOptionSelectionResponse],
    nullable: true,
    description: 'Menu-option receipt frozen at order time (Phase 5). null = no options / pre-options row.',
  })
  optionSelections: OrderItemOptionSelectionResponse[] | null;
}

export class OrderResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ description: 'Short human code shown on receipts, e.g. FO-8F3K.', example: 'FO-8F3K' })
  code: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null for guest orders.' })
  userId: string | null;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Assigned DRIVER-role user id; null while unassigned.',
  })
  driverId: string | null;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Set once when the order first enters the step; the `pending` step is `createdAt`.' })
  confirmedAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  preparingAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  deliveringAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  completedAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  cancelledAt: string | null;

  @ApiProperty({ type: 'integer', description: 'Server-computed subtotal in cents (pre-discount).' })
  subtotalCents: number;

  @ApiProperty({ type: 'integer', description: 'Promo discount in cents, always relative to subtotalCents; 0 when none.' })
  discountCents: number;

  @ApiProperty({ type: 'string', nullable: true, description: 'Normalized promo-code snapshot; null when no promo applied.' })
  promoCode: string | null;

  @ApiProperty({
    type: 'array',
    nullable: true,
    items: {
      type: 'object',
      properties: {
        menuItemId: { type: 'string', format: 'uuid' },
        quantity: { type: 'integer' },
      },
    },
    description:
      'Stock ledger frozen at creation: units this order actually decremented, aggregated per dish; null when it decremented nothing (unlimited dishes or legacy rows). Every path into cancelled returns exactly these units, once.',
  })
  stockDecrements: Array<{ menuItemId: string; quantity: number }> | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'Exactly-once restock marker — set by a CAS when the order\'s reserved stock was returned. NULL = not restocked (never reserved, not cancelled, or restock still pending).',
  })
  stockRestockedAt: string | null;

  @ApiProperty({ type: 'integer', description: 'Restaurant delivery fee in cents at order time.' })
  deliveryFeeCents: number;

  @ApiProperty({ type: 'integer', description: 'subtotal - discount + fee, cents.' })
  totalCents: number;

  @ApiProperty()
  customerName: string;

  @ApiProperty()
  contactPhone: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Contact email collected at checkout (stored normalized). Doubles as the guest receipt-view proof for GET /orders/{id}; null on legacy rows and orders that omitted it.' })
  contactEmail: string | null;

  @ApiProperty({ type: 'string' })
  deliveryAddress: string;

  @ApiProperty({ type: 'string', nullable: true })
  note: string | null;

  @ApiProperty({ type: () => [OrderItemResponse], description: 'Line items with name/price snapshots (eager relation).' })
  items: OrderItemResponse[];

  @ApiPropertyOptional({
    type: () => RestaurantResponse,
    description:
      'Embedded restaurant summary — present on GET /orders/{id}, /orders/my and status transitions; absent on the owner inbox rows.',
  })
  restaurant?: RestaurantResponse;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class PaginatedOrdersResponse {
  @ApiProperty({ type: () => [OrderResponse] })
  items: OrderResponse[];

  @ApiProperty({ type: 'integer', description: 'Total rows matching (all pages).' })
  total: number;

  @ApiProperty({ type: 'integer' })
  page: number;

  @ApiProperty({ type: 'integer' })
  limit: number;
}

export class OrderStatusCountsResponse {
  @ApiProperty({ type: 'integer' })
  pending: number;

  @ApiProperty({ type: 'integer' })
  confirmed: number;

  @ApiProperty({ type: 'integer' })
  preparing: number;

  @ApiProperty({ type: 'integer' })
  delivering: number;

  @ApiProperty({ type: 'integer' })
  completed: number;

  @ApiProperty({ type: 'integer' })
  cancelled: number;
}

/** Owner inbox: same envelope as /orders/my plus the per-status tab counts. */
export class OwnerInboxResponse extends PaginatedOrdersResponse {
  @ApiProperty({ type: () => OrderStatusCountsResponse, description: 'Counts across ALL statuses of this restaurant (independent of the status filter).' })
  counts: OrderStatusCountsResponse;
}

export class OwnerAnalyticsHourResponse {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 23, description: 'UTC hour of day.' })
  hourUtc: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Completed orders created during this UTC hour.' })
  completedOrderCount: number;
}

export class OwnerAnalyticsResponse {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'All-time sum of totalCents for completed orders.' })
  grossRevenueCents: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'All-time completed-order count.' })
  completedOrderCount: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: 23,
    nullable: true,
    description: 'UTC hour with the most completed orders; earliest hour wins ties; null when empty.',
  })
  peakHourUtc: number | null;

  @ApiProperty({
    type: () => [OwnerAnalyticsHourResponse],
    description: 'Exactly 24 UTC demand buckets, ordered hour 0 through 23.',
  })
  hourly: OwnerAnalyticsHourResponse[];
}

export class NextStatusesResponse {
  @ApiProperty({
    enum: OrderStatus,
    isArray: true,
    description: 'Statuses legally reachable from the order’s current one (empty array = terminal).',
  })
  next: OrderStatus[];
}

/**
 * Admin stale-order sweep report (POST /orders/ops/cancel-stale) — mirrors
 * `StaleSweepReport` exactly. Money-free operational counters; `cutoff` is an
 * ISO string (Dates serialize as strings), quantities are integers.
 */
export class CancelStaleResponse {
  @ApiProperty({
    type: 'integer',
    description: 'Pending-abandonment window actually applied to this run, in minutes.',
  })
  staleMinutes: number;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'ISO instant; orders with createdAt strictly before this are stale.',
  })
  cutoff: string;

  @ApiProperty({ type: 'integer', description: 'Stale pending candidates selected this run (<= limit).' })
  scanned: number;

  @ApiProperty({ type: 'integer', description: 'Orders moved pending -> cancelled by this run.' })
  cancelled: number;

  @ApiProperty({
    type: 'boolean',
    description:
      'True when the run filled its whole batch — more stale orders likely remain, re-run to drain; false when the backlog is clear.',
  })
  capped: boolean;

  @ApiProperty({
    isArray: true,
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Cancelled orders as { id, code } pairs (oldest first).',
  })
  orders: { id: string; code: string }[];
}

/**
 * Session-72 follow-up: report from the restock REPAIR pass
 * (POST /orders/ops/restock-repair). Orphans = cancelled orders that carry a
 * non-NULL stockDecrements snapshot but a NULL stockRestockedAt — the crash
 * window between the status commit and the restock transaction. `units` is
 * the summed quantity the order's own snapshot accounts for; dishes cleared
 * to unlimited in the meantime are silent per-row no-ops, exactly like the
 * live cancel path.
 */
export class RestockRepairResponse {
  @ApiProperty({
    type: 'integer',
    description: 'Crash grace window actually applied to this run, in minutes.',
  })
  graceMinutes: number;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    description: 'ISO instant; only orders with updatedAt strictly before this are repaired.',
  })
  cutoff: string;

  @ApiProperty({ type: 'integer', description: 'Orphan candidates selected this run (<= limit).' })
  scanned: number;

  @ApiProperty({
    type: 'integer',
    description: 'Orders whose reserved units THIS run moved back (marker CAS winners).',
  })
  repaired: number;

  @ApiProperty({
    type: 'integer',
    description:
      'Candidates this run did NOT move: CAS lost to a concurrent cancel, snapshot with no usable entry, or dryRun.',
  })
  skipped: number;

  @ApiProperty({
    type: 'boolean',
    description:
      'True when the run filled its whole batch — more orphans likely remain, re-run to drain; false when the backlog is clear.',
  })
  capped: boolean;

  @ApiProperty({
    isArray: true,
    type: 'object',
    properties: {
      id: { type: 'string' },
      code: { type: 'string' },
      units: { type: 'integer', description: 'Total units returned by this repair (>=1).' },
    },
    description: 'Repaired orders as { id, code, units } entries (oldest first).',
  })
  orders: { id: string; code: string; units: number }[];
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

export class FavoriteDishResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  menuItemId: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ type: 'integer', description: 'Current dish price in cents (live, not an order snapshot).' })
  priceCents: number;

  @ApiProperty({ type: 'string', nullable: true })
  category: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  imageUrl: string | null;

  @ApiProperty()
  isAvailable: boolean;

  @ApiProperty({ type: 'integer' })
  prepMinutes: number;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Live sellable units (null = unlimited).' })
  stock: number | null;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  restaurantSlug: string;

  @ApiProperty()
  restaurantIsOpen: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'When the dish was hearted.' })
  favoritedAt: string;
}

export class FavoriteListResponse {
  @ApiProperty({ type: () => [FavoriteDishResponse], description: 'Newest heart first.' })
  items: FavoriteDishResponse[];

  @ApiProperty({ type: 'integer' })
  total: number;
}

export class FavoriteAddResponse {
  @ApiProperty({ description: 'false = already hearted (idempotent retry).' })
  created: boolean;

  @ApiProperty({ type: () => FavoriteDishResponse })
  item: FavoriteDishResponse;
}

export class RemovedResponse {
  @ApiProperty({ description: 'false = nothing was removed (idempotent retry).' })
  removed: boolean;
}

// ---------------------------------------------------------------------------
// Delivery addresses
// ---------------------------------------------------------------------------

export class DeliveryAddressResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  userId: string;

  @ApiProperty({ example: 'Home', maxLength: 40 })
  label: string;

  @ApiProperty({ example: 'Dana Diner', maxLength: 120 })
  recipientName: string;

  @ApiProperty({ maxLength: 32 })
  phone: string;

  @ApiProperty({ description: 'Free-form street/city/landmarks text.' })
  address: string;

  @ApiProperty({ description: 'Exactly one address per book is default (service invariant).' })
  isDefault: boolean;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class AddressListResponse {
  @ApiProperty({ type: () => [DeliveryAddressResponse], description: 'Default first, then oldest added first.' })
  items: DeliveryAddressResponse[];

  @ApiProperty({ type: 'integer' })
  total: number;
}

/** create/update wrap the row: `{ item: {...} }`. */
export class AddressItemResponse {
  @ApiProperty({ type: () => DeliveryAddressResponse })
  item: DeliveryAddressResponse;
}

export class AddressRemoveResponse {
  @ApiProperty()
  removed: boolean;

  @ApiPropertyOptional({
    type: 'string',
    format: 'uuid',
    description: 'Only present when removing the default promoted the oldest survivor.',
  })
  promotedDefaultId?: string;
}

export class AddressDefaultResponse {
  @ApiProperty({ description: 'true = already the default (idempotent).' })
  alreadyDefault: boolean;

  @ApiProperty({ type: () => DeliveryAddressResponse })
  item: DeliveryAddressResponse;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export class ReviewRowResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  orderId: string;

  @ApiProperty({ example: 'FO-8F3K' })
  orderCode: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  restaurantSlug: string;

  @ApiProperty({ description: 'Reviewer display name only — no email/phone.' })
  reviewerName: string;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 5 })
  rating: number;

  @ApiProperty({ type: 'string', nullable: true })
  comment: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class RestaurantRatingResponse {
  @ApiProperty({ type: 'number', description: 'Recomputed server-side average (2 decimals), or the neutral default when no reviews remain.' })
  rating: number;

  @ApiProperty({ type: 'integer' })
  ratingCount: number;
}

/** POST /reviews and PATCH /reviews/{id}: row + the new restaurant aggregate. */
export class ReviewWriteResponse {
  @ApiProperty({ type: () => ReviewRowResponse })
  review: ReviewRowResponse;

  @ApiProperty({ type: () => RestaurantRatingResponse, description: 'Restaurant rating recomputed after the write.' })
  restaurant: RestaurantRatingResponse;
}

export class ReviewListResponse {
  @ApiProperty({ type: () => [ReviewRowResponse], description: 'Newest first.' })
  items: ReviewRowResponse[];

  @ApiProperty({ type: 'integer' })
  total: number;
}

/** Public feed also carries the current restaurant aggregate alongside the page. */
export class ReviewFeedResponse {
  @ApiProperty({ type: () => [ReviewRowResponse] })
  items: ReviewRowResponse[];

  @ApiProperty({ type: 'integer', description: 'Total reviews across all pages.' })
  total: number;

  @ApiProperty({ type: 'integer' })
  page: number;

  @ApiProperty({ type: 'integer' })
  limit: number;

  @ApiProperty({ type: 'number' })
  rating: number;

  @ApiProperty({ type: 'integer' })
  ratingCount: number;
}

export class ReviewRemoveResponse {
  @ApiProperty({ description: 'false = unknown/foreign id (idempotent, never 404).' })
  removed: boolean;

  @ApiPropertyOptional({
    type: () => RestaurantRatingResponse,
    description: 'Recomputed rating after the deletion; absent when nothing was removed.',
  })
  restaurant?: RestaurantRatingResponse;
}

// ---------------------------------------------------------------------------
// Promos
// ---------------------------------------------------------------------------

export const PROMO_INVALID_REASONS = [
  'not_found',
  'inactive',
  'not_started',
  'expired',
  'restaurant_mismatch',
  'below_min_subtotal',
  'total_cap_reached',
  'per_user_cap_reached',
] as const;

export class PromoValidResponse {
  @ApiProperty({ example: true })
  valid: boolean;

  @ApiProperty({ example: 'WELCOME10' })
  code: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ enum: PromoDiscountType, description: 'percent: valueCents is 1..100 of subtotal; fixed: flat cents off.' })
  discountType: PromoDiscountType;

  @ApiProperty({ type: 'integer', description: 'Code value in cents / percent points (raw definition).' })
  valueCents: number;

  @ApiProperty({ type: 'integer', description: 'Actual discount against the submitted subtotal, cents.' })
  discountCents: number;

  @ApiProperty({ type: 'integer', description: 'subtotalCents - discountCents; the delivery fee is never discounted.' })
  discountedSubtotalCents: number;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Redemption window start (inclusive); null = usable immediately.',
  })
  startsAt: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Redemption window end (exclusive); null = never expires.',
  })
  expiresAt: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Redemptions left under maxTotalUsages at preview time; null = unlimited. Authoritative check re-runs at order creation.',
  })
  remainingUsages: number | null;

  @ApiProperty()
  message: string;
}

export class PromoInvalidResponse {
  @ApiProperty({ example: false })
  valid: boolean;

  @ApiProperty({
    enum: PROMO_INVALID_REASONS,
    description: 'Why the code does not apply — the checkout UI shows the reason inline.',
  })
  reason: string;

  @ApiProperty()
  message: string;
}

/** One promo code as ADMINs see it: full definition + live ledger count. */
export class AdminPromoResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'WELCOME10', description: 'Stored normalized (uppercase, trimmed).' })
  code: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({ enum: PromoDiscountType })
  discountType: PromoDiscountType;

  @ApiProperty({ type: 'integer', description: 'percent: 1..100 points; fixed: integer cents.' })
  valueCents: number;

  @ApiProperty({ type: 'integer', nullable: true })
  maxDiscountCents: number | null;

  @ApiProperty({ type: 'integer', description: 'Pre-discount subtotal gate, integer cents.' })
  minSubtotalCents: number;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null = platform-wide.' })
  restaurantId: string | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Redemption window start (inclusive).' })
  startsAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Redemption window end (exclusive).' })
  expiresAt: string | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Total redemption cap; null = unlimited.' })
  maxTotalUsages: number | null;

  @ApiProperty({ type: 'integer', nullable: true, description: 'Per-account cap (guests exempt); null = unlimited.' })
  maxPerUser: number | null;

  @ApiProperty({ type: 'integer', description: 'Rows in the append-only redemption ledger for this code.' })
  usageCount: number;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

export class AdminPromoListResponse {
  @ApiProperty({ type: () => [AdminPromoResponse], description: 'Newest code first.' })
  items: AdminPromoResponse[];
}

/** One append-only `promo_usages` ledger row. */
export class PromoUsageRowResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  promoId: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  orderId: string;

  @ApiProperty({ type: 'string', format: 'uuid', nullable: true, description: 'null = guest redemption, or the account was erased (GDPR) while the count stands.' })
  userId: string | null;

  @ApiProperty({ type: 'integer', description: 'Integer cents actually discounted by this redemption.' })
  discountCents: number;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;
}

export class PromoUsageListResponse {
  @ApiProperty({ type: () => [PromoUsageRowResponse], description: 'Newest redemption first.' })
  items: PromoUsageRowResponse[];

  @ApiProperty({ type: 'integer' })
  total: number;

  @ApiProperty({ type: 'integer' })
  page: number;

  @ApiProperty({ type: 'integer' })
  limit: number;
}

// ---------------------------------------------------------------------------
// Payments — one payment ATTEMPT per row (retry-after-failure history is the
// point of the list). Mirrors the Payment entity as serialized by
// PaymentsService; `clientSecret` appears ONLY on the POST /payments 201 of a
// FRESH intent (null on a replay of a live pending attempt).
// ---------------------------------------------------------------------------

export class PaymentResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  orderId: string;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Payer (always set at creation; null only if the user account was later deleted — the audit row survives).',
  })
  userId: string | null;

  @ApiProperty({ description: 'Gateway adapter that handled this attempt; config-selected, never client-chosen.', example: 'mock' })
  provider: string;

  @ApiProperty({ enum: PaymentStatus })
  status: PaymentStatus;

  @ApiProperty({ type: 'integer', description: 'Snapshot of order.totalCents at intent creation. Server-copied — clients never supply amounts.' })
  amountCents: number;

  @ApiProperty({ description: 'ISO 4217 code; single-currency deployment today.', example: 'IDR' })
  currency: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "Provider-side intent id (mock: 'mock_pi_<paymentId>'). Null only when gateway intent creation itself failed.",
  })
  providerRef: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Machine-readable decline/gateway-failure reason; null while clean.' })
  failureReason: string | null;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Set once, when the payment first succeeded.' })
  succeededAt: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Cumulative cents refunded against this row (0 until an admin refunds). Partial refunds accumulate; the exact captured amount flips status to refunded.',
  })
  refundedCents: number;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'When the most recent refund landed; null while nothing was refunded.' })
  refundedAt: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'Opaque client-confirmation string (mock stand-in; meaningful only for a future SDK-backed adapter). POST /payments 201 of a FRESH intent only — absent on every other shape.',
  })
  clientSecret?: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// PaymentRefundResponse — one row of the refund AUDIT TRAIL (per landed
// refund: provider ref + amount + acting admin), written in the same
// transaction as the payment-row balance update it explains. Declined or
// errored refund attempts never appear here.
// ---------------------------------------------------------------------------

export class PaymentRefundResponse {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id: string;

  @ApiProperty({ type: 'string', format: 'uuid', description: 'Payment this refund came out of.' })
  paymentId: string;

  @ApiProperty({ description: 'Gateway adapter that executed the refund; snapshot like payment.provider.', example: 'mock' })
  provider: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "Provider-side refund id (mock: 'mock_re_<paymentId>_<remaining>_<cents>'). Null when the adapter returned no ref — the column is a snapshot, never unique-constrained.",
  })
  providerRefundRef: string | null;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'THIS refund amount in integer cents (partial refunds = multiple rows).' })
  amountCents: number;

  @ApiProperty({ type: 'integer', minimum: 1, description: "Payment.refundedCents AFTER this row landed — the running balance. SUM(rows.amountCents) must equal the payment's refundedCents." })
  refundedAfterCents: number;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description: 'Admin who issued the refund (null only if their account was later deleted — the SET NULL keeps the ledger row alive).',
  })
  actingAdminId: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Admin email snapshotted from the verified JWT at refund time — attribution outlives account deletion.',
  })
  actingAdminEmail: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;
}

export class AccountDataExportResponse {
  @ApiProperty({ type: 'integer', example: 1 })
  schemaVersion: number;

  @ApiProperty({ type: 'string', format: 'date-time' })
  generatedAt: string;

  @ApiProperty({ type: () => SafeUserResponse })
  profile: SafeUserResponse;

  @ApiProperty({ type: () => [DeliveryAddressResponse] })
  addresses: DeliveryAddressResponse[];

  @ApiProperty({ type: () => [AccountFavoriteExportResponse] })
  favorites: AccountFavoriteExportResponse[];

  @ApiProperty({ type: () => [OrderResponse] })
  orders: OrderResponse[];

  @ApiProperty({ type: () => [PaymentResponse] })
  paymentsMade: PaymentResponse[];

  @ApiProperty({ type: () => [AccountReviewExportResponse] })
  reviews: AccountReviewExportResponse[];

  @ApiProperty({ type: () => [RestaurantWithMenuResponse] })
  ownedRestaurants: RestaurantWithMenuResponse[];

  @ApiProperty({ type: () => [OrderResponse] })
  driverAssignments: OrderResponse[];

  @ApiProperty({ type: () => [PaymentRefundResponse] })
  refundsIssued: PaymentRefundResponse[];

  @ApiProperty({ type: () => [AccountSessionExportResponse] })
  sessions: AccountSessionExportResponse[];

  @ApiProperty({ type: () => [AccountPushSubscriptionExportResponse] })
  pushSubscriptions: AccountPushSubscriptionExportResponse[];
}
