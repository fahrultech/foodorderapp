'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { authedCall } from '@/lib/authed-call';
import { AdminOverview, api, formatPrice, MetricsSnapshot } from '@/lib/api';
import StatusBadge from '@/components/StatusBadge';
import TrafficPanel from '@/components/TrafficPanel';

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
        <h1 className="text-3xl font-black text-stone-900">Admin access required</h1>
        <p className="mt-3 text-stone-600">Sign in with an administrator account to open platform oversight.</p>
        <Link href="/login?next=/admin" className="mt-6 inline-flex rounded-full bg-brand-600 px-5 py-2.5 font-bold text-white hover:bg-brand-700">
          Sign in
        </Link>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-3xl font-black text-stone-900">Admin access required</h1>
        <p className="mt-3 text-stone-600">Your account can use the storefront or owner dashboard, but not platform-wide data.</p>
        <Link href="/" className="mt-6 inline-flex rounded-full border border-stone-300 px-5 py-2.5 font-bold text-stone-700 hover:bg-stone-100">
          Back to restaurants
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-600">Platform operations</p>
          <h1 className="mt-1 text-3xl font-black text-stone-900">Admin overview</h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Read-only platform totals and the newest account, restaurant, and order activity.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="rounded-full border border-stone-300 px-4 py-2 text-sm font-bold text-stone-700 hover:bg-stone-100"
        >
          Refresh
        </button>
      </div>

      {loading && <div className="mt-8 h-40 animate-pulse rounded-2xl bg-stone-100" aria-label="Loading admin overview" />}
      {error && (
        <div role="alert" className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-5 text-red-700">
          <p className="font-bold">Could not load the admin overview.</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      )}

      {data && !loading && (
        <>
          <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="Platform totals">
            <CountCard
              label="Users"
              value={data.counts.users.total}
              detail={`${data.counts.users.customer} customers · ${data.counts.users.owner} owners · ${data.counts.users.driver} drivers · ${data.counts.users.admin} admins`}
              testId="admin-count-users"
            />
            <CountCard
              label="Restaurants"
              value={data.counts.restaurants.total}
              detail={`${data.counts.restaurants.open} currently open`}
              testId="admin-count-restaurants"
            />
            <CountCard
              label="Orders"
              value={data.counts.orders.total}
              detail={`${data.counts.orders.pending} pending · ${data.counts.orders.completed} completed · ${data.counts.orders.cancelled} cancelled`}
              testId="admin-count-orders"
            />
          </section>

          <div className="mt-10">
            {metrics ? (
              <TrafficPanel snapshot={metrics} />
            ) : metricsError ? (
              <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800" data-testid="traffic-load-error">
                <p className="font-bold">Traffic metrics could not be loaded.</p>
                <p className="mt-1 text-sm">{metricsError}</p>
              </div>
            ) : null}
          </div>

          <section className="mt-10">
            <h2 className="text-xl font-black text-stone-900">Recent users</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Joined</th></tr>
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
            <h2 className="text-xl font-black text-stone-900">Recent restaurants</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">Restaurant</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">City</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Rating</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.recentRestaurants.map((restaurant) => (
                    <tr key={restaurant.id}>
                      <td className="px-4 py-3"><Link href={`/restaurants/${restaurant.id}`} className="font-bold text-brand-600 hover:underline">{restaurant.name}</Link></td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.ownerName ?? 'Platform'}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.city ?? '—'}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.isOpen ? 'Open' : 'Closed'}</td>
                      <td className="px-4 py-3 text-stone-600">{restaurant.rating.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-black text-stone-900">Recent orders</h2>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                  <tr><th className="px-4 py-3">Order</th><th className="px-4 py-3">Restaurant</th><th className="px-4 py-3">Customer</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Total</th><th className="px-4 py-3">Placed</th></tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {data.recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="px-4 py-3"><Link href={`/orders/${order.id}${order.contactEmail ? `?email=${encodeURIComponent(order.contactEmail)}` : ''}`} className="font-bold text-brand-600 hover:underline">{order.code}</Link></td>
                      <td className="px-4 py-3 text-stone-600">{order.restaurantName ?? 'Unknown'}</td>
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
