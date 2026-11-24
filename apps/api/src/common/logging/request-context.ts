import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request correlation context.
 *
 * The request-id middleware wraps `next()` in `runWithRequestContext`, so
 * everything the request pipeline runs — controllers, services, guards,
 * filters, and any async continuations they await — inherits the store.
 * The logger service reads `reqId` from here and attaches it to every
 * line, without threading the id through any function signatures.
 */
export interface RequestContext {
  reqId: string;
  /**
   * Explicit per-request restaurant attribution stamped by the metrics-
   * owned `attributeRequestRestaurant` hook (session 125, Phase 8 "order-
   * centric attribution"): routes whose unit of work CONCERNS a restaurant
   * but whose matched TEMPLATE carries no restaurant param (POST /orders,
   * the payment ladder, receipt reads) stamp the id from the loaded row,
   * and the metrics middleware's finish handler folds the sample into that
   * restaurant's bucket. The field is MUTABLE BY DESIGN: the middleware
   * captures the context OBJECT at entry (its synchronous phase runs
   * inside this module's storage.run) and reads it at 'finish' — long
   * after the async chain has left the storage scope. Reference capture,
   * not a late getStore(), is what makes the finish-time read race-free.
   */
  attributedRestaurantId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** `reqId` of the request currently being processed, if any. */
export function currentReqId(): string | undefined {
  return storage.getStore()?.reqId;
}

/**
 * The active request's context OBJECT (mutable reference), or undefined
 * outside a request. Callers that need to read fields stamped LATER (e.g.
 * at response-finish time) MUST capture this reference while still inside
 * the storage.run scope and read through the reference afterwards.
 */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
