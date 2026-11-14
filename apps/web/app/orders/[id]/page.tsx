import Link from 'next/link';
import { api, formatPrice, optionRowLabels } from '@/lib/api';
import OrderTimeline from '@/components/OrderTimeline';
import OrderLiveFeed from '@/components/OrderLiveFeed';
import RateOrderCard from '@/components/RateOrderCard';
import PaymentPanel from '@/components/PaymentPanel';
import OrderVerify from '@/components/OrderVerify';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ code?: string; pay?: string; email?: string }>;
}) {
  const { id } = await params;
  const { code, pay, email } = await searchParams;
  const t = await getTranslations('Order');
  const c = await getTranslations('Common');
  const STATUS_LABEL: Record<string, string> = {
    pending: t('pillPending'),
    confirmed: t('pillConfirmed'),
    preparing: t('pillPreparing'),
    delivering: t('pillDelivering'),
    completed: t('pillCompleted'),
    cancelled: t('pillCancelled'),
  };
  let order;
  try {
    // Phase 6 ownership fix: the uuid alone no longer reads a receipt. The
    // checkout redirect (and history links) carry the contact email as the
    // guest proof; without it this read 404s — same as an unknown order —
    // and the OrderVerify island below offers the remaining keys (bearer
    // token for owner/ADMIN, or the email typed by hand).
    order = await api.getOrder(id, { contactEmail: email });
  } catch {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <h1 className="text-xl font-bold">{t('notFoundTitle')}</h1>
        <p className="mt-1 text-sm text-stone-500">
          {t('notFoundBody')}
        </p>
        <OrderVerify orderId={id} />
        <Link href="/" className="mt-6 inline-block text-sm font-semibold text-brand-600 hover:underline">
          {t('backToRestaurants')}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center">
        <p className="text-4xl">{order.status === 'cancelled' ? '❌' : '🎉'}</p>
        <h1 className="mt-3 text-2xl font-extrabold">
          {order.status === 'cancelled'
            ? t('cancelledTitle', { code: order.code })
            : t('placedTitle', { code: order.code })}
        </h1>
        <p className="mt-1 text-sm text-stone-500">
          {(code || order.code) && t('reference', { code: order.code })} ·{' '}
          {order.restaurant?.name ?? t('restaurantFallback')}
        </p>
        <p className="mt-4 inline-block rounded-full bg-stone-100 px-4 py-2 text-sm font-semibold">
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
      </div>

      {/* Phase 5: pay-now affordance + payment receipt on the order page.
          ?pay=1 is set by checkout for signed-in customers (finish-payment nudge). */}
      <PaymentPanel
        orderId={order.id}
        orderStatus={order.status}
        totalCents={order.totalCents}
        highlight={pay === '1'}
      />

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">{t('progressTitle')}</h2>
          <OrderLiveFeed orderId={order.id} orderStatus={order.status} />
        </div>
        <OrderTimeline order={order} />
      </div>

      {order.status === 'completed' && (
        <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
          <h2 className="font-bold">{t('rateTitle')}</h2>
          <p className="mt-1 text-sm text-stone-500">
            {t('rateBody', { name: order.restaurant?.name ?? t('rateRestaurantFallback') })}
          </p>
          <RateOrderCard orderId={order.id} />
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-bold">{t('itemsTitle')}</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {order.items.map((i) => (
            <li key={i.id}>
              <div className="flex justify-between">
                <span>{c('qtyLine', { count: String(i.quantity), name: i.name })}</span>
                <span>{formatPrice(i.unitPriceCents * i.quantity)}</span>
              </div>
              {i.optionSelections && i.optionSelections.length > 0 && (
                <p className="mt-0.5 text-xs text-stone-500">
                  {optionRowLabels(i.optionSelections).join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-1 border-t border-stone-200 pt-3 text-sm">
          <div className="flex justify-between text-stone-500">
            <span>{c('subtotal')}</span>
            <span>{formatPrice(order.subtotalCents)}</span>
          </div>
          {order.discountCents > 0 && (
            <div className="flex justify-between font-medium text-emerald-600">
              <span>{c('promoLine', { code: order.promoCode ?? '' })}</span>
              <span>-{formatPrice(order.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-stone-500">
            <span>{c('wordDelivery')}</span>
            <span>{formatPrice(order.deliveryFeeCents)}</span>
          </div>
          <div className="flex justify-between text-base font-extrabold">
            <span>{c('total')}</span>
            <span>{formatPrice(order.totalCents)}</span>
          </div>
        </div>
        <div className="mt-4 border-t border-stone-200 pt-3 text-sm text-stone-500">
          <p>
            <strong className="text-stone-700">{t('deliveringTo')}</strong> {order.deliveryAddress}
          </p>
          <p className="mt-1">
            <strong className="text-stone-700">{t('contactLabel')}</strong> {order.customerName} ·{' '}
            {order.contactPhone}
          </p>
          {order.note && (
            <p className="mt-1">
              <strong className="text-stone-700">{t('noteLabel')}</strong> {order.note}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 text-center">
        <Link href="/" className="text-sm font-semibold text-brand-600 hover:underline">
          {t('orderMore')}
        </Link>
      </div>
    </div>
  );
}
