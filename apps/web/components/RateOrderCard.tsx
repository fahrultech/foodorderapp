'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api';
import type { ReviewRow } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { useAuth } from '@/lib/auth';
import { useTranslations } from 'next-intl';
import Stars from './Stars';

const COMMENT_MAX = 2000;

type CreateOutcome = { kind: 'created'; review: ReviewRow } | { kind: 'duplicate' };

/**
 * "Rate your order" widget on /orders/[id] (shown only for completed orders).
 * Owns the whole review UX for one order:
 *  - guest      → sign-in prompt with a same-origin ?next back-pointer;
 *  - signed in  → looks the order up in /reviews/my (one fetch), and either
 *    shows the existing review or the star/comment form;
 *  - submit     → POST /reviews; a concurrent 409 (double tab / retry) is
 *    absorbed by resyncing and showing the stored review, not an error.
 * The server recomputes the restaurant rating on write — this card just
 * confirms the stars landed. Edit/delete live on the API but have no UI yet
 * (roadmap polish).
 */
export default function RateOrderCard({ orderId }: { orderId: string }) {
  const { status, getAccessToken, logout } = useAuth();
  const t = useTranslations('Order');
  const th = useTranslations('Header');
  const [existing, setExisting] = useState<ReviewRow | null>(null);
  const [checking, setChecking] = useState(true);
  const [draft, setDraft] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resync = useCallback(async () => {
    const res = await authedCall(getAccessToken, logout, (t) => api.listMyReviews(t));
    if (res.ok) {
      setExisting(res.data.items.find((r) => r.orderId === orderId) ?? null);
    }
    setChecking(false);
  }, [getAccessToken, logout, orderId]);

  useEffect(() => {
    if (status === 'loading') return;
    if (status !== 'signedIn') {
      setChecking(false);
      return;
    }
    void resync();
  }, [status, resync]);

  const submit = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    const res = await authedCall<CreateOutcome>(getAccessToken, logout, async (t) => {
      try {
        const created = await api.createReview(t, {
          orderId,
          rating: draft,
          comment: comment.trim() || null,
        });
        return { kind: 'created', review: created.review };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return { kind: 'duplicate' };
        throw err;
      }
    });
    if (res.ok && res.data.kind === 'created') {
      setExisting(res.data.review);
    } else if (res.ok && res.data.kind === 'duplicate') {
      await resync(); // someone (another tab/retry) beat us — show the stored truth
    } else if (!res.ok && res.kind === 'error') {
      setError(res.message);
    }
    setBusy(false);
  };

  if (status === 'loading' || checking) {
    return <p className="mt-2 text-sm text-stone-400">{t('loading')}</p>;
  }

  if (status !== 'signedIn') {
    return (
      <p className="mt-2 text-sm text-stone-600">
        <Link
          href={`/login?next=${encodeURIComponent(`/orders/${orderId}`)}`}
          className="font-semibold text-brand-600 hover:underline"
        >
          {th('signIn')}
        </Link>{' '}
        {t('rateTail')}
      </p>
    );
  }

  if (existing) {
    return (
      <div className="mt-3 rounded-xl bg-stone-50 p-4">
        <div className="flex items-center gap-2">
          <Stars rating={existing.rating} className="text-lg" />
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            {t('yourReview')}
          </span>
        </div>
        {existing.comment && <p className="mt-2 text-sm text-stone-700">{existing.comment}</p>}
        <p className="mt-2 text-xs text-stone-400">
          {t('thanksReview', { name: existing.restaurantName })}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      {/* a11y pass #2 (session 81): the sr-only radios had NO accessible
          name (their label content was an aria-hidden ★ span) — a screen
          reader announced "radio, 1 of 5" with no meaning. Each now carries
          "N star(s)". */}
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">{t('ratingLegend')}</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input
              type="radio"
              name="review-rating"
              value={n}
              checked={draft === n}
              onChange={() => setDraft(n)}
              aria-label={t('starAria', { count: n })}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={`text-2xl transition-transform ${
                draft >= n ? 'text-amber-500' : 'text-stone-300'
              } ${draft === n ? 'scale-110' : ''}`}
            >
              {draft >= n ? '★' : '☆'}
            </span>
          </label>
        ))}
      </fieldset>
      <label htmlFor="review-comment" className="sr-only">
        {t('commentLabel')}
      </label>
      <textarea
        id="review-comment"
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
        placeholder={t('commentPlaceholder')}
        rows={3}
        maxLength={COMMENT_MAX}
        aria-describedby="review-comment-count"
        className="mt-3 w-full rounded-xl border border-stone-300 p-3 text-sm outline-none focus:border-brand-500"
      />
      <div className="mt-2 flex items-center justify-between">
        <span id="review-comment-count" className="text-xs text-stone-400">
          {comment.length}/{COMMENT_MAX}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!draft || busy}
          className="rounded-full bg-brand-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-40"
        >
          {busy ? t('submitting') : t('submitReview')}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
