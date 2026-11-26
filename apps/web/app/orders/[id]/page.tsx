import type { Metadata } from 'next';
import Link from 'next/link';
import { api, isApiDown } from '@/lib/api';
import ReceiptBody from '@/components/ReceiptBody';
import CachedReceiptFallback from '@/components/CachedReceiptFallback';
import OrderVerify from '@/components/OrderVerify';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

/**
 * Session 95 (storefront i18n sweep #3): localized document <title> for the
 * receipt route. Unlike the client surfaces this page can export metadata
 * directly — no pass-through layout needed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Order');
  return { title: t('pageTitle') };
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ code?: string; pay?: string; email?: string; rt?: string }>;
}) {
  const { id } = await params;
  const { code, pay, email, rt } = await searchParams;
  const t = await getTranslations('Order');
  let order;
  try {
    // Phase 6 ownership fix: the uuid alone no longer reads a receipt. The
    // checkout redirect (and history links) carry the contact email as the
    // guest proof; without it this read 404s — same as an unknown order —
    // and the OrderVerify island below offers the remaining keys (bearer
    // token for owner/ADMIN, or the email typed by hand). Phase 14 magic
    // link: the emailed receipt URL carries `?rt=` — a short-lived signed
    // capability that unlocks this read with NOTHING typed.
    order = await api.getOrder(id, {
      contactEmail: email,
      ...(rt ? { receiptToken: rt } : {}),
    });
  } catch (err) {
    // Phase 15 offline resilience: a DOWN read (network drop / 5xx — the
    // isApiDown split of session 77) does NOT mean the receipt is gone. The
    // browser may hold a live-sourced copy from the last successful view
    // (lib/order-cache), restored by the client island with an honest
    // "saved copy" banner. A 4xx answer stays the byte-identical not-found
    // card below — the no-existence-oracle contract (session 76) must not
    // widen: denials never learn the island path.
    if (isApiDown(err)) {
      return <CachedReceiptFallback orderId={id} />;
    }
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

  // Phase 15: the whole success view lives in ReceiptBody — ONE source the
  // offline restore island renders from localStorage too. `persist` triggers
  // the per-id localStorage write (browser-only; this is the live read).
  return (
    <ReceiptBody
      order={order}
      codeHint={code}
      payHighlight={pay === '1'}
      receiptToken={rt || undefined}
      persist
    />
  );
}
