'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api';
import type { ReviewRow } from '@/lib/api';
import { authedCall } from '@/lib/authed-call';
import { useAuth } from '@/lib/auth';
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
    return <p className="mt-2 text-sm text-stone-400">Loading…</p>;
  }

  if (status !== 'signedIn') {
    return (
      <p className="mt-2 text-sm text-stone-600">
        <Link
          href={`/login?next=${encodeURIComponent(`/orders/${orderId}`)}`}
          className="font-semibold text-brand-600 hover:underline"
        >
          Sign in
        </Link>{' '}
        to rate this order — your review helps other diners.
      </p>
    );
  }

  if (existing) {
    return (
      <div className="mt-3 rounded-xl bg-stone-50 p-4">
        <div className="flex items-center gap-2">
          <Stars rating={existing.rating} className="text-lg" />
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Your review
          </span>
        </div>
        {existing.comment && <p className="mt-2 text-sm text-stone-700">{existing.comment}</p>}
        <p className="mt-2 text-xs text-stone-400">
          Thanks for the feedback! It counts toward {existing.restaurantName}&apos;s rating.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Your rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input
              type="radio"
              name="review-rating"
              value={n}
              checked={draft === n}
              onChange={() => setDraft(n)}
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
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value.slice(0, COMMENT_MAX))}
        placeholder="How was the food and delivery? (optional)"
        rows={3}
        maxLength={COMMENT_MAX}
        className="mt-3 w-full rounded-xl border border-stone-300 p-3 text-sm outline-none focus:border-brand-500"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-stone-400">{comment.length}/{COMMENT_MAX}</span>
        <button
          type="button"
          onClick={submit}
          disabled={!draft || busy}
          className="rounded-full bg-brand-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-40"
        >
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
