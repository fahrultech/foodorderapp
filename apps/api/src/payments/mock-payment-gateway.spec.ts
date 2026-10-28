import { MockPaymentGateway, resolveMockMode, resolveMockRefundMode } from './mock-payment-gateway';
import { selectPaymentGateway } from './payments.module';
import { PaymentGateway, supportsRefunds } from './payment-gateway.interface';

/**
 * The mock adapter + provider selection (Phase 5 "payment abstraction").
 * The mock's whole job is to be a FAITHFUL PaymentGateway: deterministic ids,
 * honest amount contract, env-driven decline mode. If it drifts from the
 * interface contract, the future Stripe adapter inherits the drift.
 */
const intentInput = (amountCents = 4200) => ({
  paymentId: 'p-1',
  orderId: 'o-1',
  orderCode: 'FO-TEST',
  amountCents,
  currency: 'IDR',
  customerRef: 'u-1',
});

describe('MockPaymentGateway', () => {
  const gw = new MockPaymentGateway();
  const saved = process.env.MOCK_PAY_GATEWAY_MODE;
  const savedRefund = process.env.MOCK_REFUND_GATEWAY_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.MOCK_PAY_GATEWAY_MODE;
    else process.env.MOCK_PAY_GATEWAY_MODE = saved;
    if (savedRefund === undefined) delete process.env.MOCK_REFUND_GATEWAY_MODE;
    else process.env.MOCK_REFUND_GATEWAY_MODE = savedRefund;
  });

  it('identifies as "mock"', () => {
    expect(gw.id).toBe('mock');
  });

  it('derives intent ids deterministically from OUR payment id', async () => {
    const a = await gw.createIntent(intentInput());
    expect(a).toEqual({
      providerRef: 'mock_pi_p-1',
      clientSecret: 'mock_secret_p-1',
    });
    const b = await gw.createIntent(intentInput());
    expect(b.providerRef).toBe(a.providerRef); // greppable + stable
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'refuses a non-positive/float amount (%p) on BOTH verbs — money contract is not "normalize", it is "reject"',
    async (amount) => {
      await expect(gw.createIntent(intentInput(amount as number))).rejects.toThrow(TypeError);
      await expect(
        gw.capture({ paymentId: 'p', providerRef: 'r', amountCents: amount as number }),
      ).rejects.toThrow(TypeError);
    },
  );

  it('captures successfully by default', async () => {
    delete process.env.MOCK_PAY_GATEWAY_MODE;
    expect(await gw.capture({ paymentId: 'p', providerRef: 'mock_pi_p', amountCents: 100 })).toEqual({
      succeeded: true,
    });
  });

  it('declines every capture when MOCK_PAY_GATEWAY_MODE=fail (case-insensitive)', async () => {
    for (const mode of ['fail', 'FAIL', 'Fail']) {
      process.env.MOCK_PAY_GATEWAY_MODE = mode;
      expect(await gw.capture({ paymentId: 'p', providerRef: 'r', amountCents: 100 })).toEqual({
        succeeded: false,
        reason: 'mock_declined',
      });
    }
  });

  it('resolveMockMode: only an explicit fail means fail; garbage means succeed', () => {
    expect(resolveMockMode({})).toBe('succeed');
    expect(resolveMockMode({ MOCK_PAY_GATEWAY_MODE: '' })).toBe('succeed');
    expect(resolveMockMode({ MOCK_PAY_GATEWAY_MODE: 'nope' })).toBe('succeed');
    expect(resolveMockMode({ MOCK_PAY_GATEWAY_MODE: ' fail ' })).toBe('succeed'); // whitespace ≠ fail (documented strictness)
    expect(resolveMockMode({ MOCK_PAY_GATEWAY_MODE: 'fail' })).toBe('fail');
  });

  // ---- refund add-on interface -------------------------------------------

  it('implements the refund capability probe (mock is refund-capable)', () => {
    expect(supportsRefunds(gw)).toBe(true);
    expect(supportsRefunds({ id: 'x', createIntent: async () => ({ providerRef: '' }), capture: async () => ({ succeeded: true }) })).toBe(false);
  });

  it('refunds deterministically by default: id derives from payment + remainder-before + split size', async () => {
    delete process.env.MOCK_REFUND_GATEWAY_MODE;
    expect(
      await gw.refundIntent({ paymentId: 'p-1', providerRef: 'mock_pi_p-1', amountCents: 1500, remainingCents: 4200, currency: 'IDR' }),
    ).toEqual({ succeeded: true, providerRefundRef: 'mock_re_p-1_4200_1500' });
    // A different partial split of the same intent gets a distinguishable ref…
    const second = await gw.refundIntent({ paymentId: 'p-1', providerRef: 'mock_pi_p-1', amountCents: 900, remainingCents: 2700, currency: 'IDR' });
    expect(second.providerRefundRef).toBe('mock_re_p-1_2700_900');
    // …and so do TWO EQUAL splits: the remainder-before component makes every
    // refund of one intent unique, which the persisted audit ledger requires.
    const equalSplit = await gw.refundIntent({ paymentId: 'p-1', providerRef: 'mock_pi_p-1', amountCents: 900, remainingCents: 1800, currency: 'IDR' });
    expect(equalSplit.providerRefundRef).toBe('mock_re_p-1_1800_900');
    expect(equalSplit.providerRefundRef).not.toBe(second.providerRefundRef);
  });

  it.each([0, -1, 1.5, NaN, Infinity])(
    'refunds obey the SAME money contract as pay/capture — refuses (%p)',
    async (amount) => {
      await expect(
        gw.refundIntent({ paymentId: 'p', providerRef: 'r', amountCents: amount as number, remainingCents: 100, currency: 'IDR' }),
      ).rejects.toThrow(TypeError);
    },
  );

  it('rejects a negative remainingCents — the caller bookkeeping is already broken', async () => {
    await expect(
      gw.refundIntent({ paymentId: 'p', providerRef: 'r', amountCents: 100, remainingCents: -1, currency: 'IDR' }),
    ).rejects.toThrow(TypeError);
  });

  it('declines refunds only via the SEPARATE refund knob (capture stays succeed)', async () => {
    delete process.env.MOCK_PAY_GATEWAY_MODE;
    process.env.MOCK_REFUND_GATEWAY_MODE = 'fail';
    expect(await gw.refundIntent({ paymentId: 'p', providerRef: 'r', amountCents: 100, remainingCents: 100, currency: 'IDR' })).toEqual({
      succeeded: false,
      reason: 'mock_refund_declined',
    });
    // One knob must not flip the other verb — the live smoke relies on this.
    expect(await gw.capture({ paymentId: 'p', providerRef: 'r', amountCents: 100 })).toEqual({ succeeded: true });
  });

  it('resolveMockRefundMode: same strict-read semantics as the pay knob', () => {
    expect(resolveMockRefundMode({})).toBe('succeed');
    expect(resolveMockRefundMode({ MOCK_REFUND_GATEWAY_MODE: 'nope' })).toBe('succeed');
    expect(resolveMockRefundMode({ MOCK_REFUND_GATEWAY_MODE: 'FAIL' })).toBe('fail');
  });
});

describe('selectPaymentGateway', () => {
  const mock: PaymentGateway = { id: 'mock', createIntent: async () => ({ providerRef: 'x' }), capture: async () => ({ succeeded: true }) };

  it('defaults to mock when PAYMENT_PROVIDER is unset/blank', () => {
    expect(selectPaymentGateway(undefined, [mock])).toBe(mock);
    expect(selectPaymentGateway('', [mock])).toBe(mock);
    expect(selectPaymentGateway('  MOCK  ', [mock])).toBe(mock); // case/space tolerant
  });

  it('FAILS FAST at boot on an unknown provider instead of silently using mock', () => {
    expect(() => selectPaymentGateway('stripe', [mock])).toThrowError(/Unknown PAYMENT_PROVIDER "stripe"/);
    expect(() => selectPaymentGateway('xendit', [mock])).toThrowError(/implemented adapters: mock/);
  });
});
