import { currentRequestContext } from '../logging/request-context';
import { restaurantBucketKeyOf } from './request-metrics';

/**
 * EXPLICIT service-side opt-in hook for per-restaurant attribution
 * (session 125, Phase 8 "order-centric attribution").
 *
 * The session-98 dimension attributes a sample to a restaurant ONLY when
 * the matched route TEMPLATE carries the restaurant param
 * (`/api/restaurants/:id/...`). POST /orders, the payment ladder
 * (`POST /payments`, `POST /payments/:id/capture`,
 * `GET /orders/:orderId/payments`) and the receipt read (`GET /orders/:id`)
 * all CONCERN a restaurant but address it through the ORDER — the id lives
 * in the body or one join away in the DB. A url heuristic is forbidden
 * (the session-85/98 rule: an owner view may never be built from guesswork
 * about someone else's bytes), so the SERVICE — which has just loaded the
 * real row — declares the restaurant explicitly by calling this hook.
 *
 * Mechanism: stamp the mutable RequestContext that requestIdMiddleware
 * activated around the whole pipeline (AsyncLocalStorage). The metrics
 * middleware captured that same object reference at entry and folds the
 * finish-time sample into `restaurantScopeOf(req) ?? attributedRestaurantId`
 * — template match wins whenever one exists, so attribution can only ever
 * ADD coverage for restaurant-param-less routes, never override a matched
 * template (pinned in request-metrics.integration.spec.ts).
 *
 * Honesty rules inherited from the existing dimension, unchanged:
 *  - non-uuid or empty ids are IGNORED (junk can never mint a bucket);
 *  - outside a request context (scripts, schedulers, direct service
 *    calls from unit tests) the hook is a no-op, never a throw — the
 *    background writers that reuse these services must not trip;
 *  - the bucket minting rule stays 2xx-ONLY (top-up-only for 3xx/4xx/5xx),
 *    so a failed create can attribute eagerly at row-resolution time and
 *    still can never fabricate a bucket;
 *  - authorization denials that throw BEFORE the row is loaded (foreign
 *    orders 404ing without existence leak) are never attributed at all —
 *    the no-oracle doctrine extends to the owner's own traffic view.
 */
export function attributeRequestRestaurant(restaurantId: string | null | undefined): void {
  const key = restaurantBucketKeyOf(restaurantId);
  if (!key) return;
  const ctx = currentRequestContext();
  if (ctx) ctx.attributedRestaurantId = key;
}
