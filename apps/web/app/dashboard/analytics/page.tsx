'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import PortalTabs from '@/components/PortalTabs';
import { useAuth } from '@/lib/auth';
import { api, formatPrice } from '@/lib/api';
import type { Restaurant, RestaurantAnalytics } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { useTranslations } from 'next-intl';

function hourLabel(hourUtc: number): string {
  const start = String(hourUtc).padStart(2, '0');
  const end = String((hourUtc + 1) % 24).padStart(2, '0');
  return `${start}:00–${end}:00 UTC`;
}

export default function AnalyticsPage() {
  const t = useTranslations('Portal');
  const ts = useTranslations('PortalStates');
  const { status, user, getAccessToken, logout } = useAuth();
  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<RestaurantAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const isOwnerish = user?.role === 'owner' || user?.role === 'admin';

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish) return;
    let alive = true;
    void (async () => {
      const res = await authedCall(getAccessToken, logout, (token) =>
        api.listMyRestaurants(token),
      );
      if (!alive) return;
      if (res.ok) {
        setRestaurants(res.data);
        setSelectedId((current) =>
          current && res.data.some((restaurant) => restaurant.id === current)
            ? current
            : res.data[0]?.id ?? null,
        );
        setError(null);
      } else if (res.kind === 'error') {
        setRestaurants([]);
        setError(t('restaurantsLoadError', { message: res.message }));
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, reloadKey, getAccessToken, logout]);

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish || !selectedId) {
      if (restaurants) setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setAnalytics(null);
    setError(null);
    void (async () => {
      const res = await authedCall(getAccessToken, logout, (token) =>
        api.getRestaurantAnalytics(token, selectedId),
      );
      if (!alive) return;
      if (res.ok) {
        setAnalytics(res.data);
      } else if (res.kind === 'error') {
        setError(t('errCouldNotLoadAnalytics', { message: res.message }));
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, selectedId, reloadKey, restaurants, getAccessToken, logout]);

  const selected = useMemo(
    () => (restaurants ?? []).find((restaurant) => restaurant.id === selectedId) ?? null,
    [restaurants, selectedId],
  );
  const maxCount = Math.max(1, ...(analytics?.hourly.map((bucket) => bucket.completedOrderCount) ?? [0]));

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-4xl" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-28 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      </div>
    );
  }

  if (status !== 'signedIn') {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">📊</p>
        <h1 className="mt-2 text-xl font-bold">{t('anGateTitle')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('anGateBody')}</p>
        <Link href="/login?next=/dashboard/analytics" className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
          {t('signIn')}
        </Link>
      </div>
    );
  }

  if (!isOwnerish) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
        <p className="text-2xl">🔑</p>
        <h1 className="mt-2 text-xl font-bold">{t('ownerGateTitle')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('anOwnerGateBody')}</p>
        <Link href="/orders/my" className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700">
          {t('viewMyOrders')}
        </Link>
      </div>
    );
  }

  if (restaurants && restaurants.length === 0 && !error) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-extrabold">{t('anTitle')}</h1>
        <PortalTabs />
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍽️</p>
          <h2 className="mt-2 text-lg font-bold">{ts('noRestaurantTitle')}</h2>
          <p className="mt-1 text-sm text-stone-500">{t('anNoRestaurantBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{t('anTitle')}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {t('anSub', { restaurant: selected?.name ?? t('fallbackRestaurantName') })}
          </p>
        </div>
        <button onClick={() => setReloadKey((key) => key + 1)} className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100">
          {t('refresh')}
        </button>
      </div>

      <PortalTabs />

      {restaurants && restaurants.length > 0 && (
        <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-stone-700">
          {t('restaurantLabel')}
          <select
            value={selectedId ?? ''}
            onChange={(event) => setSelectedId(event.target.value)}
            className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm"
          >
            {restaurants.map((restaurant) => (
              <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700" role="alert">
          <span>{error}</span>
          <button onClick={() => setReloadKey((key) => key + 1)} className="rounded-lg border border-rose-200 bg-white px-3 py-1 text-xs font-bold">{t('tryAgain')}</button>
        </div>
      )}

      {loading ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-28 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      ) : analytics ? (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-3" aria-label={t('anSummaryAria')}>
            <div className="rounded-2xl border border-stone-200 bg-white p-5" data-testid="analytics-gross-revenue">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('anGross')}</p>
              <p className="mt-2 text-3xl font-extrabold text-stone-900">{formatPrice(analytics.grossRevenueCents)}</p>
              <p className="mt-1 text-xs text-stone-500">{t('anGrossDetail')}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5" data-testid="analytics-completed-orders">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('anCompleted')}</p>
              <p className="mt-2 text-3xl font-extrabold text-stone-900">{analytics.completedOrderCount}</p>
              <p className="mt-1 text-xs text-stone-500">{t('anAllTime')}</p>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-5" data-testid="analytics-busiest-hour">
              <p className="text-xs font-bold uppercase tracking-wide text-stone-400">{t('anBusiest')}</p>
              <p className="mt-2 text-xl font-extrabold text-stone-900">
                {analytics.peakHourUtc === null ? t('anNoCompleted') : hourLabel(analytics.peakHourUtc)}
              </p>
              <p className="mt-1 text-xs text-stone-500">{t('anByCreated')}</p>
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-stone-200 bg-white p-5">
            <div>
              <h2 className="text-lg font-bold">{t('anHourly')}</h2>
              <p className="text-sm text-stone-500">{t('anHourlyBody')}</p>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full border-collapse text-sm" aria-label={t('anTableAria')}>
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-400">
                    <th scope="col" className="px-2 py-2">{t('anThHour')}</th>
                    <th scope="col" className="px-2 py-2">{t('anThDemand')}</th>
                    <th scope="col" className="px-2 py-2 text-right">{t('anCompleted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.hourly.map((bucket) => (
                    <tr key={bucket.hourUtc} className="border-b border-stone-100 last:border-0">
                      <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-semibold text-stone-700">{hourLabel(bucket.hourUtc)}</th>
                      <td className="w-full px-2 py-2">
                        <div className="h-2 rounded-full bg-stone-100" aria-hidden="true">
                          <div className="h-2 rounded-full bg-brand-500" style={{ width: `${(bucket.completedOrderCount / maxCount) * 100}%` }} />
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right font-bold tabular-nums">{bucket.completedOrderCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}
