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

// ---------------------------------------------------------------------------
// Restaurants & menu (wire = TypeORM entity JSON; unloaded relations absent)
// ---------------------------------------------------------------------------

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

  @ApiProperty()
  isOpen: boolean;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
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

  @ApiProperty({ type: 'string', format: 'uuid' })
  restaurantId: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt: string;
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
// Orders
// ---------------------------------------------------------------------------

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

  @ApiProperty({ type: 'integer', description: 'Unit price in cents (snapshot).' })
  unitPriceCents: number;
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

  @ApiProperty({ type: 'integer', description: 'Restaurant delivery fee in cents at order time.' })
  deliveryFeeCents: number;

  @ApiProperty({ type: 'integer', description: 'subtotal - discount + fee, cents.' })
  totalCents: number;

  @ApiProperty()
  customerName: string;

  @ApiProperty()
  contactPhone: string;

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
  'restaurant_mismatch',
  'below_min_subtotal',
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
