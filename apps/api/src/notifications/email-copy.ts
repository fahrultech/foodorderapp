/**
 * Email copy templates (EN + ID) for customer-facing order notifications.
 *
 * DI-free, pure functions — same doctrine as the other `email`-adjacent
 * helpers (payment-confirm-gate, delivery-eta): unit specs pin the copy,
 * the service wires inputs.
 *
 * Locale doctrine (Phase 13 guest-email item): the API has NO stored signal
 * for what language a recipient reads — the storefront locale lives in a
 * cookie on the web side and order rows carry none. So:
 *   - authenticated recipients keep the ENGLISH templates byte-identical
 *     (until a per-user locale lands), and
 *   - guest recipients get BOTH languages in one message (EN block then ID
 *     block): the market defaults are EN+ID, and bilingual is the honest
 *     rendering when the recipient's language is unknown — guessing either
 *     single language from an email address would be invention.
 * The `locales` array IS the extension point: pass ['id'] (or ['en','id']
 * in either order) and the same builders render accordingly.
 */
import { OrderStatus } from '../orders/order.entity';

export type EmailLocale = 'en' | 'id';

/** One fully rendered email. */
export interface RenderedEmail {
  subject: string;
  text: string;
}

/**
 * Everything the confirmation template renders. Structural subset of Order
 * so the service can hand the fetched entity straight in.
 */
export interface ConfirmationEmailView {
  code: string;
  customerName: string;
  deliveryAddress: string;
  subtotalCents: number;
  discountCents: number | null;
  promoCode: string | null;
  deliveryFeeCents: number;
  totalCents: number;
  restaurant: { name: string };
  items: Array<{ name: string; quantity: number; unitPriceCents: number }>;
  /** Magic-link receipt URL (Phase 14 #5). Absent/null renders NO link line. */
  receiptUrl?: string | null;
}

/** Lighter subset for status-step notices (no line items rendered). */
export interface StatusEmailView {
  code: string;
  customerName: string;
  restaurant: { name: string };
  receiptUrl?: string | null;
}

/**
 * Customer-facing status-update subjects/lines, per locale. PENDING is
 * intentionally absent — the confirmation email IS the creation notice and
 * pending is an interim state only. The EN values are byte-pinned by specs
 * against the pre-extraction templates (session 45 wording).
 */
export const STATUS_UPDATE_LABELS: Record<EmailLocale, Partial<Record<OrderStatus, string>>> = {
  en: {
    [OrderStatus.CONFIRMED]: 'Your order has been confirmed',
    [OrderStatus.PREPARING]: 'Your order is being prepared',
    [OrderStatus.DELIVERING]: 'Your order is on its way',
    [OrderStatus.COMPLETED]: 'Your order has been delivered',
    [OrderStatus.CANCELLED]: 'Your order has been cancelled',
  },
  id: {
    [OrderStatus.CONFIRMED]: 'Pesanan Anda telah dikonfirmasi',
    [OrderStatus.PREPARING]: 'Pesanan Anda sedang disiapkan',
    [OrderStatus.DELIVERING]: 'Pesanan Anda sedang diantar',
    [OrderStatus.COMPLETED]: 'Pesanan Anda telah diantarkan',
    [OrderStatus.CANCELLED]: 'Pesanan Anda telah dibatalkan',
  },
};

/** True when a status has any customer-facing email notice (service fast-path). */
export function hasStatusNotice(status: OrderStatus): boolean {
  return STATUS_UPDATE_LABELS.en[status] !== undefined;
}

/** Subject title of the order-placed confirmation, per locale. */
const CONFIRMATION_TITLE: Record<EmailLocale, string> = {
  en: 'Order confirmed',
  id: 'Pesanan dikonfirmasi',
};

/** Separator line between language blocks of a bilingual email. */
const LOCALE_SEPARATOR = '------------------------------';

interface LocaleStrings {
  greeting: (name: string) => string;
  thanks: (restaurant: string) => string;
  order: string;
  deliverTo: string;
  items: string;
  subtotal: string;
  discount: string;
  deliveryFee: string;
  total: string;
  keepPosted: string;
  viewOrder: string;
  restaurant: string;
  cancelHint: string;
}

const COPY: Record<EmailLocale, LocaleStrings> = {
  en: {
    greeting: (n) => `Hi ${n},`,
    thanks: (r) => `Thanks for your order from ${r}!`,
    order: 'Order',
    deliverTo: 'Deliver to',
    items: 'Items',
    subtotal: 'Subtotal',
    discount: 'Discount',
    deliveryFee: 'Delivery fee',
    total: 'Total',
    keepPosted: 'We will keep you posted as your order moves forward.',
    viewOrder: 'View your order',
    restaurant: 'Restaurant',
    cancelHint: 'If you did not request a cancellation, please contact support.',
  },
  id: {
    greeting: (n) => `Hai ${n},`,
    thanks: (r) => `Terima kasih atas pesanan Anda dari ${r}!`,
    order: 'Pesanan',
    deliverTo: 'Kirim ke',
    items: 'Item',
    subtotal: 'Subtotal',
    discount: 'Diskon',
    deliveryFee: 'Biaya pengiriman',
    total: 'Total',
    keepPosted: 'Kami akan terus mengabari Anda seiring pesanan Anda berjalan.',
    viewOrder: 'Lihat pesanan Anda',
    restaurant: 'Restoran',
    cancelHint: 'Jika Anda tidak meminta pembatalan, silakan hubungi dukungan.',
  },
};

/** Format integer cents as a human-readable amount (IDR 12,500). */
export function formatCents(cents: number): string {
  return `IDR ${(cents).toLocaleString('id-ID')}`;
}

/**
 * Join rendered blocks. 1 locale -> the body VERBATIM (byte-identity with the
 * pre-extraction templates is spec-pinned); 2 -> locale-SORTED sections (input
 * order never changes the output) with subjects merged as
 * "EN label / ID label" + a shared suffix (the order code).
 */
function compose(
  entries: Array<{ locale: EmailLocale; title: string; body: string }>,
  suffix: string,
): RenderedEmail {
  const sorted = [...entries].sort((a, b) => (a.locale === b.locale ? 0 : a.locale < b.locale ? -1 : 1));
  return {
    subject: `${sorted.map((e) => e.title).join(' / ')}${suffix}`,
    text:
      sorted.length === 1
        ? sorted[0].body
        : `${sorted[0].body}\n\n${LOCALE_SEPARATOR}\n\n${sorted[1].body}`,
  };
}

function confirmationBody(order: ConfirmationEmailView, locale: EmailLocale): string {
  const c = COPY[locale];
  const itemLines = order.items
    .map((i) => `  • ${i.name} × ${i.quantity}  ${formatCents(i.unitPriceCents * i.quantity)}`)
    .join('\n');
  return [
    c.greeting(order.customerName),
    ``,
    c.thanks(order.restaurant.name),
    ``,
    `${c.order}: #${order.code}`,
    `${c.deliverTo}: ${order.deliveryAddress}`,
    ``,
    `${c.items}:`,
    itemLines,
    ``,
    `${c.subtotal}: ${formatCents(order.subtotalCents)}`,
    order.discountCents
      ? `${c.discount}: -${formatCents(order.discountCents)}${order.promoCode ? ` (${order.promoCode})` : ''}`
      : null,
    `${c.deliveryFee}: ${formatCents(order.deliveryFeeCents)}`,
    `${c.total}: ${formatCents(order.totalCents)}`,
    ``,
    c.keepPosted,
    // Magic-link receipt line (Phase 14 #5): absent url -> NO extra bytes
    // (the session-45 byte-identity pins stay valid for URL-less renders).
    order.receiptUrl ? `` : null,
    order.receiptUrl ? `${c.viewOrder}: ${order.receiptUrl}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Render the order-placed confirmation for the given locales.
 * `['en']` reproduces the session-45 email byte-for-byte.
 */
export function confirmationEmail(
  order: ConfirmationEmailView,
  locales: EmailLocale[],
): RenderedEmail {
  return compose(
    locales.map((l) => ({ locale: l, title: CONFIRMATION_TITLE[l], body: confirmationBody(order, l) })),
    ` — #${order.code}`,
  );
}

function statusBody(order: StatusEmailView, label: string, locale: EmailLocale, status: OrderStatus): string {
  const c = COPY[locale];
  return [
    c.greeting(order.customerName),
    ``,
    `${label}.`,
    ``,
    `${c.order}: #${order.code}`,
    `${c.restaurant}: ${order.restaurant.name}`,
    ...(order.receiptUrl ? [``, `${c.viewOrder}: ${order.receiptUrl}`] : []),
    status === OrderStatus.CANCELLED ? `\n${c.cancelHint}` : '',
  ].join('\n');
}

/**
 * Render a status-step email, or null when the status has no customer-facing
 * notice (pending — and any status no locale labels). Subjects carry every
 * rendered label ("Your order... / Pesanan Anda... — #CODE").
 */
export function statusUpdateEmail(
  order: StatusEmailView,
  status: OrderStatus,
  locales: EmailLocale[],
): RenderedEmail | null {
  const labelled = locales
    .map((l) => [l, STATUS_UPDATE_LABELS[l][status]] as const)
    .filter((entry): entry is [EmailLocale, string] => entry[1] !== undefined);
  if (labelled.length === 0) return null;
  return compose(
    labelled.map(([l, label]) => ({
      locale: l,
      title: label,
      body: statusBody(order, label, l, status),
    })),
    ` — #${order.code}`,
  );
}

/**
 * Owner daily digest (docs/ROADMAP.md Phase 17, Product loop).
 *
 * Recipients are AUTHENTICATED owners, so the ENGLISH-only doctrine in this
 * file's header applies verbatim: no bilingual block, no locale guessing.
 * The runner composes one email per owner covering every owned restaurant;
 * a restaurant with zero orders in the window still gets a (boring) section,
 * but an owner with no orders ANYWHERE never receives this at all — the
 * zero-mail rule lives in owner-digest.ts, not here.
 */
export interface DigestRestaurantView {
  name: string;
  orderCount: number;
  completedCount: number;
  cancelledCount: number;
  revenueCents: number;
  /** Pre-ranked, pre-sliced (qty DESC, name ASC); empty = nothing sold. */
  topDishes: Array<{ name: string; quantity: number }>;
}

export interface DigestEmailView {
  ownerName: string;
  /** Covered calendar day, 'YYYY-MM-DD'. */
  date: string;
  restaurants: DigestRestaurantView[];
}

export function ownerDigestEmail(view: DigestEmailView): RenderedEmail {
  const sections = view.restaurants.map((r) => {
    const dishes =
      r.topDishes.length === 0
        ? '  Top dishes: none'
        : ['  Top dishes:', ...r.topDishes.map((d) => `    - ${d.name} x${d.quantity}`)].join('\n');
    return [
      r.name,
      `  Orders: ${r.orderCount} (${r.completedCount} completed, ${r.cancelledCount} cancelled)`,
      `  Completed revenue: ${formatCents(r.revenueCents)}`,
      dishes,
    ].join('\n');
  });
  const plural = view.restaurants.length === 1 ? 'restaurant' : 'restaurants';
  return {
    subject: `FoodOrder owner digest - ${view.date}`,
    text: [
      `Hi ${view.ownerName},`,
      ``,
      `Here is how your ${plural} did on ${view.date}:`,
      ``,
      sections.join('\n\n'),
      ``,
      `- FoodOrder`,
    ].join('\n'),
  };
}
