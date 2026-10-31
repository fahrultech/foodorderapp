import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Central OpenAPI document config, used by main.ts (SwaggerModule.setup at
 * /api/docs) AND by swagger.spec.ts, so the spec validates exactly the
 * document the live server serves.
 *
 * @nestjs/swagger 11 quirks (verified empirically, not from old docs):
 * - createDocument INCLUDES the app's global prefix in `paths`
 *   (e.g. "/api/auth/login").
 * - SwaggerModule.setup does NOT prepend the global prefix to its mount
 *   path — so the mount path must carry "api/" itself to satisfy the
 *   roadmap contract "docs at /api/docs". Hence UI lands at /api/docs and
 *   the JSON at /api/docs-json, exactly matching the document's server-
 *   relative paths.
 */
export const SWAGGER_UI_PATH = 'api/docs';
export const SWAGGER_JSON_PATH = 'api/docs-json';

/** Tag list — keep in sync with the @ApiTags used on controllers. */
export const SWAGGER_TAGS = [
  'health',
  'auth',
  'users',
  'cities',
  'restaurants',
  'menu',
  'orders',
  'reviews',
  'promos',
  'payments',
  'notifications',
] as const;

export function buildSwaggerDocumentConfig() {
  return new DocumentBuilder()
    .setTitle('FoodOrder API')
    .setVersion('0.1.0')
    .setDescription(
      [
        'Order-food REST API: NestJS + TypeORM + PostgreSQL.',
        '',
        '**Auth** — `POST /auth/login` returns `{ access_token, refresh_token }`.',
        'Send the access token as `Authorization: Bearer <access_token>`',
        '(click *Authorize* above). Access tokens are short-lived; mint a new',
        'one with `POST /auth/refresh`.',
        '',
        '**Roles** — owner/admin routes additionally require the role carried',
        'inside the token (`customer` | `owner` | `admin`).',
        '',
        '**Money** — every amount is an integer number of cents.',
        '',
        '**Errors** — all failures use the envelope',
        '`{ "error": { "code", "message", "details?" } }`',
        '(validation failures return 400 with per-field `details`).',
        '',
        '**Rate limits** — `auth`, `orders` and `payments` endpoints are',
        'throttled per client IP; exceeding the window returns 429 with a',
      '`Retry-After` header.',
        '',
        'Every response carries an `x-request-id` header for log correlation.',
      ].join('\n'),
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from POST /auth/login or POST /auth/refresh',
      },
      'bearer',
    )
    .addTag('health', 'Liveness/readiness probe (used by Docker healthchecks).')
    .addTag('auth', 'Register, login, refresh-token rotation, logout, session identity.')
    .addTag('users', 'Self-service profile, favorites, delivery-address book (JWT-scoped).')
    .addTag('cities', 'Active delivery-city registry for storefront scoping.')
    .addTag('restaurants', 'Public browse/search + owner onboarding and edits.')
    .addTag('menu', 'Public dish listing + owner dish CRUD.')
    .addTag('orders', 'Checkout (guest allowed), order history, cancellation, status machine.')
    .addTag('reviews', 'Ratings on completed orders + public restaurant review feed.')
    .addTag('promos', 'Promo-code preview for the cart.')
    .addTag('payments', 'Payment attempts behind the provider abstraction (mock gateway today).')
    .addTag('notifications', 'Browser push configuration and JWT-scoped subscriptions.')
    .build();
}
