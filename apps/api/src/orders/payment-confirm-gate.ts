/**
 * Feature flag behind the order-machine gate (docs/ROADMAP.md Phase 5):
 * when ON, moving an order INTO `confirmed` requires a `succeeded` payment
 * row on that order — the owner (and the admin backdoor) cannot accept an
 * unpaid order.
 *
 * ENABLED BY DEFAULT (the session-44 "enable-by-default decision"): unset,
 * empty, or garbage means ON. The ONLY way to take the gate out is an
 * explicit opt-out spelling — 0/false/no/off (trimmed, case-insensitive) —
 * reserved for dev/CI rigs that drive the status machine without a paying
 * step.
 *
 * Why the flip: every prerequisite landed. The mock gateway settles
 * synchronously, the web pay button + `?pay=1` checkout handoff are wired
 * (session 43), and the e2e fixtures now pay before any owner confirm —
 * so shipping the gate inert "because fixtures weren't ready" would only
 * keep confirming-unpaid-orders as the accidental production behaviour.
 *
 * Fail-CLOSED on garbage is deliberate and the exact mirror of the old
 * rule: a typo'd opt-out (e.g. `flase`) must not silently disable a
 * money-integrity gate, the way a typo'd enable once must not have silently
 * blocked order flow. An operator who wants the gate off writes it
 * unambiguously; everything else keeps payment enforced.
 *
 * Deployment-level switch, read once per transition from ConfigService
 * (`ORDER_CONFIRM_REQUIRES_PAYMENT`): flipping the env var + restart is the
 * only "rollout" machinery, deliberately — there is no per-tenant flag
 * store yet (roadmap: "A/B-friendly feature flags table").
 */
const EXPLICIT_OFF = new Set(['0', 'false', 'no', 'off']);

export function confirmGateEnabled(raw: string | undefined | null): boolean {
  return !EXPLICIT_OFF.has(String(raw ?? '').trim().toLowerCase());
}
