import Link from 'next/link';
import { api, formatPrice } from '@/lib/api';
import OrderTimeline from '@/components/OrderTimeline';
import OrderLiveFeed from '@/components/OrderLiveFeed';
import RateOrderCard from '@/components/RateOrderCard';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  pending: '🕐 Pending — waiting for the restaurant to confirm',
  confirmed: '✅ Confirmed by the restaurant',
  preparing: '👨‍🍳 Being prepared',
  delivering: '🛵 On the way to you',
  completed: '🎉 Delivered — enjoy your meal!',
  cancelled: '❌ Cancelled',
};

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ code?: string }>;
}) {
  const { id } = await params;
  const { code } = await searchParams;
  let order;
  try {
    order = await api.getOrder(id);
  } catch {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <h1 className="text-xl font-bold">Order not found</h1>
        <p className="mt-1 text-sm text-stone-500">The API may be offline, or the link is wrong.</p>
        <Link href="/" className="mt-6 inline-block text-sm font-semibold text-brand-600 hover:underline">
          ← Back to restaurants
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center">
        <p className="text-4xl">{order.status === 'cancelled' ? '❌' : '🎉'}</p>
        <h1 className="mt-3 text-2xl font-extrabold">
          {order.status === 'cancelled' ? `Order ${order.code} cancelled` : `Order ${order.code} placed!`}
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          {(code || order.code) && `Reference: ${order.code}`} ·{' '}
          {order.restaurant?.name ?? 'Restaurant'}
        </p>
        <p className="mt-4 inline-block rounded-full bg-stone-100 px-4 py-2 text-sm font-semibold">
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">Order progress</h2>
          <OrderLiveFeed orderId={order.id} orderStatus={order.status} />
        </div>
        <OrderTimeline order={order} />
      </div>

      {order.status === 'completed' && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="font-bold">Rate your order</h2>
          <p className="mt-1 text-sm text-stone-500">
            How was {order.restaurant?.name ?? 'the restaurant'}? One review per completed order.
          </p>
          <RateOrderCard orderId={order.id} />
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">Items</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {order.items.map((i) => (
            <li key={i.id} className="flex justify-between">
              <span>
                {i.quantity} × {i.name}
              </span>
              <span>{formatPrice(i.unitPriceCents * i.quantity)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm">
          <div className="flex justify-between text-stone-500">
            <span>Subtotal</span>
            <span>{formatPrice(order.subtotalCents)}</span>
          </div>
          {order.discountCents > 0 && (
            <div className="flex justify-between font-medium text-emerald-600">
              <span>Promo ({order.promoCode})</span>
              <span>-{formatPrice(order.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-stone-500">
            <span>Delivery</span>
            <span>{formatPrice(order.deliveryFeeCents)}</span>
          </div>
          <div className="flex justify-between text-base font-extrabold">
            <span>Total</span>
            <span>{formatPrice(order.totalCents)}</span>
          </div>
        </div>
        <div className="mt-4 border-t border-stone-200 pt-3 text-sm text-stone-500">
          <p>
            <strong className="text-stone-700">Delivering to:</strong> {order.deliveryAddress}
          </p>
          <p className="mt-1">
            <strong className="text-stone-700">Contact:</strong> {order.customerName} · {order.contactPhone}
          </p>
          {order.note && (
            <p className="mt-1">
              <strong className="text-stone-700">Note:</strong> {order.note}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 text-center">
        <Link href="/" className="text-sm font-semibold text-brand-600 hover:underline">
          ← Order more food
        </Link>
      </div>
    </div>
  );
}
