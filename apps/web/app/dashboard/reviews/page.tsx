'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import PortalTabs from '@/components/PortalTabs';
import ReviewReplyComposer from '@/components/ReviewReplyComposer';
import type { ReplyBusy } from '@/components/ReviewReplyComposer';
import Stars from '@/components/Stars';
import { PortalLoadFailed, PortalOffline } from '@/components/PortalOffline';
import { useAuth } from '@/lib/auth';
import { ApiError, api, isApiDown } from '@/lib/api';
import type { Restaurant, ReviewRow } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';

/**
 * Owner reply surface (Phase 9 sub-item, session 102) for the session-101
 * reply endpoints. The READ rides the public feed
 * (`GET /restaurants/:id/reviews` — it embeds `reply`/`repliedAt`, so the
 * owner sees exactly what the storefront sees); only the WRITE pair
 * (`PATCH`/`DELETE /reviews/:id/reply`) needs the bearer. Access stays
 * server-decided either way — this page renders the composer for its listed
 * restaurants, and the API's `getOwned` ladder (owner of the review's
 * restaurant, ADMIN bypass) is what actually guards the write.
 */
const FEED_LIMIT = 50; // MAX_PAGE_SIZE on this stack — the clamps ignore anything larger.

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export default function ReviewsPage() {
  const t = useTranslations('Portal');
  const ts = useTranslations('PortalStates');
  const { status, user, getAccessToken, logout } = useAuth();
  const isOwnerish = user?.role === 'owner' || user?.role === 'admin';

  const [restaurants, setRestaurants] = useState<Restaurant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Feed state. `rows === null` means "never loaded (successfully) since the
  // last selection change" — the empty card may ONLY render after rows is a
  // real array (session 91 rule: a failed load never claims "no reviews").
  const [rows, setRows] = useState<ReviewRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [rating, setRating] = useState<number | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedFailure, setFeedFailure] = useState<{ message: string; down: boolean } | null>(null);

  const [busy, setBusy] = useState<Record<string, ReplyBusy>>({});
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // --- restaurant list (same ladder as analytics) ---
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
            : (res.data[0]?.id ?? null),
        );
      } else if (res.kind === 'error') {
        setRestaurants([]);
        setFeedFailure({ message: t('restaurantsLoadError', { message: res.message }), down: res.down });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, reloadKey, getAccessToken, logout]);

  // --- review feed for the selected restaurant ---
  const loadFeed = useCallback(async () => {
    if (!selectedId) return;
    setFeedLoading(true);
    setFeedFailure(null);
    try {
      const feed = await api.listRestaurantReviews(selectedId, { limit: FEED_LIMIT });
      setRows(feed.items);
      setTotal(feed.total);
      setPage(1);
      setRating(feed.rating);
    } catch (err) {
      setRows(null);
      setFeedFailure({
        message: t('errCouldNotLoadReviews', { message: errorMessage(err) }),
        down: isApiDown(err),
      });
    }
    setFeedLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (status !== 'signedIn' || !isOwnerish) return;
    setRows(null);
    setRating(null);
    void loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isOwnerish, selectedId, reloadKey, loadFeed]);

  /** Append the next feed page — the seeded fixtures are small, but an
   *  owner with >50 reviews must be able to reach them all. */
  const loadMore = async () => {
    if (!selectedId) return;
    setFeedLoading(true);
    try {
      const feed = await api.listRestaurantReviews(selectedId, {
        page: page + 1,
        limit: FEED_LIMIT,
      });
      setRows((current) => {
        const seen = new Set((current ?? []).map((row) => row.id));
        return [...(current ?? []), ...feed.items.filter((row) => !seen.has(row.id))];
      });
      setTotal(feed.total);
      setPage(feed.page);
    } catch (err) {
      setFeedFailure({
        message: t('errCouldNotLoadReviews', { message: errorMessage(err) }),
        down: isApiDown(err),
      });
    }
    setFeedLoading(false);
  };

  const replaceRow = (review: ReviewRow) =>
    setRows((current) => (current ?? []).map((row) => (row.id === review.id ? review : row)));

  /** One write path for save+replace (PATCH) and clear (DELETE): the fresh
   *  row comes back in `{ review }`; null = success, string = message. */
  const runReplyCall = useCallback(
    async (reviewId: string, mode: 'save' | 'clear', text?: string): Promise<string | null> => {
      setBusy((current) => ({ ...current, [reviewId]: mode === 'save' ? 'saving' : 'clearing' }));
      const res = await authedCall(getAccessToken, logout, (token) =>
        mode === 'save'
          ? api.setReviewReply(token, reviewId, text as string)
          : api.clearReviewReply(token, reviewId),
      );
      setBusy((current) => ({ ...current, [reviewId]: 'idle' }));
      if (res.ok) {
        replaceRow(res.data.review);
        setStatusMsg(
          mode === 'save'
            ? t('announceSaved', { code: res.data.review.orderCode })
            : t('announceCleared', { code: res.data.review.orderCode }),
        );
        return null;
      }
      if (res.kind === 'signedOut') return t('errSessionExpired');
      return res.message;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getAccessToken, logout],
  );

  const selected = useMemo(
    () => (restaurants ?? []).find((restaurant) => restaurant.id === selectedId) ?? null,
    [restaurants, selectedId],
  );

  // --- render gates (dashboard/analytics idiom) ---
  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-4xl" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-lg bg-stone-200" aria-hidden />
        <div className="mt-6 space-y-4">
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
        <p className="text-2xl">💬</p>
        <h1 className="mt-2 text-xl font-bold">{t('rvGateTitle')}</h1>
        <p className="mt-1 text-sm text-stone-500">{t('rvGateBody')}</p>
        <Link
          href="/login?next=/dashboard/reviews"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
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
        <p className="mt-1 text-sm text-stone-500">{t('rvOwnerGateBody')}</p>
        <Link
          href="/orders/my"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t('viewMyOrders')}
        </Link>
      </div>
    );
  }

  if (restaurants && restaurants.length === 0 && !feedFailure) {
    // Reached for an owner with no restaurant AND for ADMIN: the reply
    // ladder lets an admin answer any review, but `GET /restaurants/mine`
    // is ownership-scoped and answers `[]`, so there is nothing to select.
    // The switcher renders only when restaurants.length > 0, so `rows` can
    // NEVER load here — reaching the "no reviews yet" card would be the
    // session-91 lie (an empty claim over un-fetched data).
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-extrabold">{t('rvTitle')}</h1>
        <PortalTabs />
        <div className="mt-6 rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center">
          <p className="text-2xl">🍽️</p>
          <h2 className="mt-2 text-lg font-bold">{ts('noRestaurantTitle')}</h2>
          <p className="mt-1 text-sm text-stone-500">{t('rvNoRestaurantBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">{t('rvTitle')}</h1>
          <p className="mt-1 text-sm text-stone-500">
            {t('rvSub', { restaurant: selected?.name ?? t('fallbackRestaurantName') })}
          </p>
        </div>
        <button
          onClick={() => setReloadKey((key) => key + 1)}
          className="rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100"
        >
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
              <option key={restaurant.id} value={restaurant.id}>
                {restaurant.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* polite live region for write outcomes (portal-a11y doctrine) */}
      <p role="status" className="sr-only" data-testid="reply-status">
        {statusMsg ?? ''}
      </p>

      {feedFailure &&
        (feedFailure.down ? (
          <PortalOffline onRetry={() => setReloadKey((key) => key + 1)} />
        ) : (
          <PortalLoadFailed
            message={feedFailure.message}
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        ))}

      {feedLoading && !rows && (
        <div className="mt-6 space-y-4" aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-32 animate-pulse rounded-2xl bg-stone-100" aria-hidden />
          ))}
        </div>
      )}

      {rows && !feedFailure && (
        <section className="mt-6" aria-label={t('rvListAria')}>
          <p className="text-sm text-stone-500" data-testid="review-rating-line">
            {total === 0
              ? t('rvEmpty')
              : t('rvRated', {
                  rating: (rating ?? 0).toFixed(1),
                  count: total,
                })}
          </p>
          {rows.length > 0 && (
            <ul className="mt-4 space-y-4">
              {rows.map((row) => (
                <li key={row.id} className="rounded-2xl border border-stone-200 bg-white p-5" data-testid="owner-review-row">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-bold">{row.reviewerName}</span>
                    <time className="text-xs text-stone-400" dateTime={row.createdAt}>
                      {row.createdAt.slice(0, 10)}
                    </time>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <Stars rating={row.rating} className="text-sm" />
                    <span className="text-xs text-stone-400">{t('rvOrderCode', { code: row.orderCode })}</span>
                  </div>
                  {row.comment && <p className="mt-2 text-sm text-stone-600">{row.comment}</p>}
                  <ReviewReplyComposer
                    review={row}
                    busy={busy[row.id] ?? 'idle'}
                    onSave={(text) => runReplyCall(row.id, 'save', text)}
                    onDelete={() => runReplyCall(row.id, 'clear')}
                  />
                </li>
              ))}
            </ul>
          )}
          {rows.length < total && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={feedLoading}
              className="mt-4 rounded-xl border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:opacity-60"
            >
              {t('rvLoadMore', { shown: String(rows.length), total: String(total) })}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
