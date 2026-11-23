import { OrderStatus } from '../orders/order.entity';
import {
  confirmationEmail,
  formatCents,
  hasStatusNotice,
  statusUpdateEmail,
  STATUS_UPDATE_LABELS,
  ConfirmationEmailView,
} from './email-copy';

/**
 * `legacy*` re-implements the session-45 inline templates (copied from the
 * pre-refactor order-notifications.service.ts) so the ENGLISH render stays
 * BYTE-IDENTICAL after the extraction — any copy drift fails here, not in
 * production inboxes.
 */
function legacyConfirmationText(order: ConfirmationEmailView): string {
  const itemLines = order.items
    .map((i) => `  • ${i.name} × ${i.quantity}  ${formatCents(i.unitPriceCents * i.quantity)}`)
    .join('\n');
  return [
    `Hi ${order.customerName},`,
    ``,
    `Thanks for your order from ${order.restaurant.name}!`,
    ``,
    `Order: #${order.code}`,
    `Deliver to: ${order.deliveryAddress}`,
    ``,
    `Items:`,
    itemLines,
    ``,
    `Subtotal: ${formatCents(order.subtotalCents)}`,
    order.discountCents
      ? `Discount: -${formatCents(order.discountCents)}${order.promoCode ? ` (${order.promoCode})` : ''}`
      : null,
    `Delivery fee: ${formatCents(order.deliveryFeeCents)}`,
    `Total: ${formatCents(order.totalCents)}`,
    ``,
    `We will keep you posted as your order moves forward.`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function legacyStatusText(
  order: { code: string; customerName: string; restaurant: { name: string } },
  label: string,
  status: OrderStatus,
): string {
  return [
    `Hi ${order.customerName},`,
    ``,
    `${label}.`,
    ``,
    `Order: #${order.code}`,
    `Restaurant: ${order.restaurant.name}`,
    status === OrderStatus.CANCELLED
      ? `\nIf you did not request a cancellation, please contact support.`
      : '',
  ].join('\n');
}

function view(overrides: Partial<ConfirmationEmailView> = {}): ConfirmationEmailView {
  return {
    code: 'FO-TEST',
    customerName: 'Alice',
    deliveryAddress: '123 Main St',
    subtotalCents: 10000,
    discountCents: 0,
    promoCode: null,
    deliveryFeeCents: 2000,
    totalCents: 12000,
    restaurant: { name: 'Burger Palace' },
    items: [{ name: 'Burger', quantity: 2, unitPriceCents: 5000 }],
    ...overrides,
  };
}

const statusView = { code: 'FO-TEST', customerName: 'Alice', restaurant: { name: 'Burger Palace' } };

describe('email-copy: English byte-identity vs the session-45 templates', () => {
  it('confirmation without discount renders the legacy text exactly', () => {
    const o = view();
    const msg = confirmationEmail(o, ['en']);
    expect(msg.subject).toBe('Order confirmed — #FO-TEST');
    expect(msg.text).toBe(legacyConfirmationText(o));
  });

  it('confirmation with promo discount renders the legacy text exactly', () => {
    const o = view({ discountCents: 1500, promoCode: 'SAVE10' });
    expect(confirmationEmail(o, ['en']).text).toBe(legacyConfirmationText(o));
  });

  it('confirmation without a promo code renders the discount line without parens', () => {
    const o = view({ discountCents: 1500, promoCode: null });
    expect(confirmationEmail(o, ['en']).text).toBe(legacyConfirmationText(o));
  });

  it.each([
    [OrderStatus.CONFIRMED, 'Your order has been confirmed'],
    [OrderStatus.PREPARING, 'Your order is being prepared'],
    [OrderStatus.DELIVERING, 'Your order is on its way'],
    [OrderStatus.COMPLETED, 'Your order has been delivered'],
    [OrderStatus.CANCELLED, 'Your order has been cancelled'],
  ])('status %s renders the legacy subject + text exactly', (status, label) => {
    const msg = statusUpdateEmail(statusView, status, ['en']);
    expect(msg).not.toBeNull();
    expect(msg!.subject).toBe(`${label} — #FO-TEST`);
    expect(msg!.text).toBe(legacyStatusText(statusView, label, status));
  });

  it('pending has no notice: builder null + hasStatusNotice false', () => {
    expect(statusUpdateEmail(statusView, OrderStatus.PENDING, ['en'])).toBeNull();
    expect(statusUpdateEmail(statusView, OrderStatus.PENDING, ['en', 'id'])).toBeNull();
    expect(hasStatusNotice(OrderStatus.PENDING)).toBe(false);
    expect(hasStatusNotice(OrderStatus.CONFIRMED)).toBe(true);
  });
});

describe('email-copy: Indonesian + bilingual rendering (guest path)', () => {
  it('id-only confirmation renders the Indonesian copy', () => {
    const msg = confirmationEmail(view(), ['id']);
    expect(msg.subject).toBe('Pesanan dikonfirmasi — #FO-TEST');
    expect(msg.text).toContain('Hai Alice,');
    expect(msg.text).toContain('Terima kasih atas pesanan Anda dari Burger Palace!');
    expect(msg.text).toContain('Pesanan: #FO-TEST');
    expect(msg.text).toContain('Kirim ke: 123 Main St');
    expect(msg.text).toContain('Biaya pengiriman:');
    expect(msg.text).toContain('Kami akan terus mengabari Anda seiring pesanan Anda berjalan.');
  });

  it('id confirmation localizes the discount label but keeps money format', () => {
    const msg = confirmationEmail(view({ discountCents: 1500, promoCode: 'SAVE10' }), ['id']);
    expect(msg.text).toContain('Diskon: -IDR 1.500 (SAVE10)');
  });

  it('bilingual confirmation = EN block, separator, ID block, merged subject', () => {
    const o = view();
    const msg = confirmationEmail(o, ['en', 'id']);
    expect(msg.subject).toBe('Order confirmed / Pesanan dikonfirmasi — #FO-TEST');
    expect(msg.text).toContain('We will keep you posted as your order moves forward.');
    expect(msg.text).toContain('Kami akan terus mengabari Anda seiring pesanan Anda berjalan.');
    const [enBlock, idBlock] = msg.text.split(/\n\n-+\n\n/);
    expect(enBlock).toBe(legacyConfirmationText(o));
    expect(idBlock).toContain('Hai Alice,');
    expect(idBlock).not.toContain('Hi Alice,');
  });

  it('locale argument order does not matter (sorted output)', () => {
    const o = view();
    expect(confirmationEmail(o, ['id', 'en'])).toEqual(confirmationEmail(o, ['en', 'id']));
    expect(
      statusUpdateEmail(statusView, OrderStatus.CONFIRMED, ['id', 'en']),
    ).toEqual(statusUpdateEmail(statusView, OrderStatus.CONFIRMED, ['en', 'id']));
  });

  it('bilingual status update merges labels in the subject and both bodies', () => {
    const msg = statusUpdateEmail(statusView, OrderStatus.DELIVERING, ['en', 'id']);
    expect(msg!.subject).toBe('Your order is on its way / Pesanan Anda sedang diantar — #FO-TEST');
    const [enBlock, idBlock] = msg!.text.split(/\n\n-+\n\n/);
    expect(enBlock).toBe(legacyStatusText(statusView, 'Your order is on its way', OrderStatus.DELIVERING));
    expect(idBlock).toContain('Pesanan Anda sedang diantar.');
    expect(idBlock).toContain('Restoran: Burger Palace');
  });

  it('cancelled bilingual email carries the support hint in BOTH languages', () => {
    const msg = statusUpdateEmail(statusView, OrderStatus.CANCELLED, ['en', 'id']);
    expect(msg!.text).toContain('If you did not request a cancellation, please contact support.');
    expect(msg!.text).toContain('Jika Anda tidak meminta pembatalan, silakan hubungi dukungan.');
  });

  it('every en status label has an id counterpart (no half-localized notice)', () => {
    const en = Object.keys(STATUS_UPDATE_LABELS.en).sort();
    expect(Object.keys(STATUS_UPDATE_LABELS.id).sort()).toEqual(en);
    for (const k of en) {
      expect(STATUS_UPDATE_LABELS.id[k as OrderStatus]).not.toBe(STATUS_UPDATE_LABELS.en[k as OrderStatus]);
    }
  });
});

describe('email-copy: formatCents', () => {
  it('formats integer cents with IDR + id-ID grouping', () => {
    expect(formatCents(1250000)).toBe('IDR 1.250.000');
    expect(formatCents(0)).toBe('IDR 0');
  });
});
