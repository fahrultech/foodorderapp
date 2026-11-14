'use client';

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { authedCall } from '@/lib/authed-call';
import { AdminOverview, api, formatPrice, MetricsSnapshot } from '@/lib/api';
import StatusBadge from '@/components/StatusBadge';

// Bundle trim (Phase 8): the traffic panel is NOT part of the /admin route
// payload anymore. The dynamic import only starts when the component is
// first RENDERED, and the render gate below is `metrics != null` — so the
// chunk is fetched strictly BEHIND the GET /admin/metrics round-trip. Admins
// on a metrics outage (or a 401) never download it. ssr:false because the
// snapshot is bearer-only client data — there is nothing to server-render.
/** Module-scope dynamic() cannot call hooks — this tiny component owns the
 *  localized skeleton aria-label (Portal.trafficLoadingAria, session 93). */
function TrafficPanelSkeleton() {
  const t = useTranslations('Portal');
  return (
    <div
      className="h-40 animate-pulse rounded-2xl border border-stone-200 bg-stone-50"
      aria-label={t('trafficLoadingAria')}
      data-testid="traffic-panel-loading"
    />
  );
}

const TrafficPanel = dynamic(() => import('@/components/TrafficPanel'), {
  ssr: false,
  loading: () => <TrafficPanelSkeleton />,
});

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function CountCard({
  label,
  value,
  detail,
  testId,
}: {
  label: string;
  value: number;
  detail: string;
  testId: string;
}) {
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm" data-testid={testId}>
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-stone-500">{label}</p>
      <p className="mt-2 text-3xl font-black text-stone-900">{value}</p>
      <p className="mt-1 text-sm text-stone-500">{detail}</p>
    </article>
  );
}

export default function AdminPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const t = useTranslations('Portal');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    if (status !== 'signedIn' || !isAdmin) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    setMetricsError(null);
    void (async () => {
      // Overview failure keeps the existing banner semantics; a metrics-only
      // failure never blanks the tables — it degrades the traffic section.
      const [overviewResult, metricsResult] = await Promise.all([
        authedCall(getAccessToken, logout, (token) => api.adminOverview(token)),
        authedCall(getAccessToken, logout, (token) => api.adminMetrics(token)),
      ]);
      if (!alive) return;
      if (overviewResult.ok) setData(overviewResult.data);
      else if (overviewResult.kind === 'error') setError(overviewResult.message);
      if (metricsResult.ok) setMetrics(metricsResult.data);
      else if (metricsResult.kind === 'error') setMetricsError(metricsResult.message);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [status, isAdmin, getAccessToken, logout, reloadKey]);

  if (status === 'loading') {
    return <main className="mx-auto max-w-6xl px-4 py-10"><div className="h-40 animate-pulse rounded-2xl bg-stone-100" /></main>;
  }

  if (status === 'guest') {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-3xl font-black text-stone-900">{t('adminGateTitle')}</h1>
        <p className="mt-3 text-stone-600">{t('adminGateGuestBody')}</p>
        <Link href="/login?next=/admin" className="mt-6 inline-flex rounded-full bg-brand-600 px-5 py-2.5 font-bold text-white hover:bg-brand-700">
          {t('signIn')}
        </Link>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-3xl font-black text-stone-900">{t('adminGateTitle')}</h1>
        <p className="mt-3 text-stone-600">{t('adminGateOtherBody')}</p>
        <Link href="/" className="mt-6 inline-flex rounded-full border border-stone-300 px-5 py-2.5 font-bold text-stone-700 hover:bg-stone-100">
          {t('backToRestaurants')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">{t('adminEyebrow')}</p>
          <h1 className="mt-1 text-3xl font-black text-stone-900">{t('adminTitle')}</h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">{t('adminSub')}</p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="rounded-full border border-stone-300 px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-100"
        >
          {t('refreshPlain')}
        </button>
      </div>

      {loading && <div className="mt-8 h-40 animate-pulse rounded-2xl bg-stone-100" aria-label={t('adminLoadingAria')} />}
      {error && (
        <div role="alert" className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">
          <p className="font-bold">{t('adminLoadError')}</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      )}

      {data && !loading && (
        <>
          <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label={t('totalsAria')}>
            <CountCard
              label={t('countUsers')}
              value={data.counts.users.total}
              detail={t('usersDetail', {
                customers: String(data.counts.users.customer),
                owners: String(data.counts.users.owner),
                drivers: String(data.counts.users.driver),
                admins: String(data.counts.users.admin),
              })}
              testId="admin-count-users"
            />
            <CountCard
              label={t('countRestaurants')}
              value={data.counts.restaurants.total}
              detail={t('restaurantsDetail', { open: String(data.counts.restaurants.open) })}
              testId="admin-count-restaurants"
            />
            <CountCard
              label={t('countOrders')}
              value={data.counts.orders.total}
              detail={t('ordersDetail', {
                pending: String(data.counts.orders.pending),
                completed: String(data.counts.orders.completed),
                cancelled: String(data.counts.orders.cancelled),
              })}
              testId="admin-count-orders"
            />
          </section>

          <div className="mt-10">
            {metrics ? (
              <TrafficPanel snapshot={metrics} />
            ) : metricsError ? (
              <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800" data-testid="traffic-load-error">
                <p className="font-bold">{t('trafficLoadError')}</p>
                <p className="mt-1 text-sm">{metricsError}</p>
              </div>
            ) : null}
          </div>

          <section className="mt-10">
            <h2 className="text-xl font-black text-stone-900">{t('recentUsers')}</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">{t('thName')}</th><th className="px-4 py-3">{t('thEmail')}</th><th className="px-4 py-3">{t('thRole')}</th><th className="px-4 py-3">{t('thJoined')}</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.recentUsers.map((account) => (
                    <tr key={account.id}>
                      <td className="px-4 py-3 font-bold text-stone-900">{account.name}</td>
                      <td className="px-4 py-3 text-stone-600">{account.email}</td>
                      <td className="px-4 py-3 capitalize text-stone-600">{account.role}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-stone-500">{formatDate(account.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-black text-stone-900">{t('recentRestaurants')}</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">{t('restaurantLabel')}</th><th className="px-4 py-3">{t('thOwner')}</th><th className="px-4 py-3">{t('thCity')}</th><th className="px-4 py-3">{t('thState')}</th><th className="px-4 py-3">{t('thRating')}</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.recentRestaurants.map((restaurant) => (
                    <tr key={restaurant.id}>
                      <td className="px-4 py-3"><Link href={`/restaurants/${restaurant.id}`} className="font-bold text-brand-600 hover:underline">{restaurant.name}</Link></td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.ownerName ?? t('platformFallback')}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.city ?? '—'}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.isOpen ? t('openState') : t('closedState')}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.rating.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-black text-stone-900">{t('recentOrders')}</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">{t('thOrder')}</th><th className="px-4 py-3">{t('restaurantLabel')}</th><th className="px-4 py-3">{t('thCustomer')}</th><th className="px-4 py-3">{t('thStatus')}</th><th className="px-4 py-3">{t('thTotal')}</th><th className="px-4 py-3">{t('thPlaced')}</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="px-4 py-3"><Link href={`/orders/${order.id}${order.contactEmail ? `?email=${encodeURIComponent(order.contactEmail)}` : ''}`} className="font-bold text-brand-600 hover:underline">{order.code}</Link></td>
                      <td className="px-4 py-3 text-stone-600">{order.restaurantName ?? t('unknownFallback')}</td>
                      <td className="px-4 py-3 text-stone-600">{order.customerName}</td>
                      <td className="px-4 py-3"><StatusBadge status={order.status} /></td>
                      <td className="whitespace-nowrap px-4 py-3 font-bold text-stone-900">{formatPrice(order.totalCents)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-stone-500">{formatDate(order.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
