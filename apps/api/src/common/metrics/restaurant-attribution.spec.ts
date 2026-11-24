import { RequestContext, currentRequestContext, runWithRequestContext } from '../logging/request-context';
import { attributeRequestRestaurant } from './restaurant-attribution';

/**
 * Unit pins for the session-125 service-side opt-in hook
 * (Phase 8 "order-centric attribution"). The wire behavior through the
 * real middleware chain lives in request-metrics.integration.spec.ts;
 * this file pins the HOOK contract itself: when it stamps, when it is a
 * silent no-op, and the finish-time reference semantics the middleware
 * relies on.
 */

const RID = '4f5a6b7c-8d9e-4f01-9234-56789abcdef0';

describe('attributeRequestRestaurant', () => {
  it('no request context: silent no-op (background/service-direct calls must never throw)', () => {
    expect(() => attributeRequestRestaurant(RID)).not.toThrow();
  });

  it('stamps the ACTIVE context, lowercased (bucket-key canonicalization)', () => {
    const ctx: RequestContext = { reqId: 't1' };
    runWithRequestContext(ctx, () => {
      attributeRequestRestaurant(RID.toUpperCase());
      expect(ctx.attributedRestaurantId).toBe(RID);
      // the store reader and the caller's object are the SAME reference
      expect(currentRequestContext()).toBe(ctx);
    });
  });

  it('non-uuid shapes are ignored — junk can never mint a bucket', () => {
    const ctx: RequestContext = { reqId: 't2' };
    runWithRequestContext(ctx, () => {
      attributeRequestRestaurant('warung');
      attributeRequestRestaurant('1111');
      attributeRequestRestaurant('4f5a6b7c-8d9e-4f01-9234-56789abcdef'); // short by one
      expect(ctx.attributedRestaurantId).toBeUndefined();
      attributeRequestRestaurant(RID);
      expect(ctx.attributedRestaurantId).toBe(RID);
    });
  });

  it('null/undefined/empty stamp attempts are inert', () => {
    const ctx: RequestContext = { reqId: 't3' };
    runWithRequestContext(ctx, () => {
      attributeRequestRestaurant(null);
      attributeRequestRestaurant(undefined);
      expect(ctx.attributedRestaurantId).toBeUndefined();
    });
  });

  it('last explicit stamp wins (one request, one attributed restaurant)', () => {
    const ctx: RequestContext = { reqId: 't4' };
    const RID2 = '9a8b7c6d-5e4f-4d01-8234-56789abcdef1';
    runWithRequestContext(ctx, () => {
      attributeRequestRestaurant(RID);
      attributeRequestRestaurant(RID2);
      expect(ctx.attributedRestaurantId).toBe(RID2);
    });
  });

  it('finish-time semantics: a reference captured BEFORE stamping reads the stamp AFTER', () => {
    // Exactly the middleware pattern: synchronous capture at entry, read
    // in the 'finish' callback after the storage.run scope is long gone.
    let captured: ReturnType<typeof currentRequestContext>;
    const handler = () => {
      captured = currentRequestContext();
    };
    const ctx: RequestContext = { reqId: 't5' };
    runWithRequestContext(ctx, handler);
    attributeRequestRestaurant(RID); // outside the run — like a late continuation
    expect(captured?.attributedRestaurantId).toBeUndefined(); // ctx NOT stamped here: stamp targets the ACTIVE store
    // inside a run the stamp lands on the same object the reference holds:
    runWithRequestContext(ctx, () => {
      attributeRequestRestaurant(RID);
    });
    expect(captured?.attributedRestaurantId).toBe(RID);
  });
});
