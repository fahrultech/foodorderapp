/**
 * Feature flag behind the order-machine gate (docs/ROADMAP.md Phase 5):
 * when ON, moving an order INTO `confirmed` requires a `succeeded` payment
 * row on that order — the owner (and the admin backdoor) cannot accept an
 * unpaid order. When OFF (the default), the status machine behaves exactly
 * as it always has: no payment is consulted on any transition.
 *
 * Deployment-level switch, read once per transition from ConfigService
 * (`ORDER_CONFIRM_REQUIRES_PAYMENT`): flipping the env var + restart is the
 * only "rollout" machinery, deliberately — there is no per-tenant flag store
 * yet (roadmap: "A/B-friendly feature flags table").
 *
 * Truthy spellings mirror the other ops knobs (DRY_RUN etc.): 1/true/yes/on,
 * case-insensitive, trimmed. Anything else (empty, garbage, 'false', '0')
 * means OFF — fail-OPEN (gate inert), because silently blocking order flow
 * on a typo'd env value is the worse failure mode.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function confirmGateEnabled(raw: string | undefined | null): boolean {
  return TRUTHY.has(String(raw ?? '').trim().toLowerCase());
}
