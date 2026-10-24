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
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** `reqId` of the request currently being processed, if any. */
export function currentReqId(): string | undefined {
  return storage.getStore()?.reqId;
}
