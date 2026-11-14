'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';
import { useTranslations } from 'next-intl';

/**
 * Receipt-proof fallback (API Phase 6 ownership fix). `GET /orders/:id` no
 * longer trusts the uuid alone: the SSR receipt page only renders when the
 * proof (`?email=` from the checkout redirect / a history link) unlocks it.
 * When the server-side read 404s, THIS island offers the two remaining keys:
 *
 * 1. signed-in users: one bearer-token probe — the owner/ADMIN ladder is
 *    server-side truth, and a hit re-enters the SSR page with the order's
 *    own stored proof email (never typed, never guessed);
 * 2. guests: a "what email did you check out with?" form. A correct answer
 *    reloads the page carrying that proof; a wrong one stays indistinguishable
 *    from an unknown order (the API never confirms existence, so we can't
 *    honestly say more than "nothing unlocked").
 */
export default function OrderVerify({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { status, getAccessToken } = useAuth();
  const t = useTranslations('Order');
  const [checking, setChecking] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Signed-in bearer rung: ask the API once. Owner/ADMIN answers 200 with the
  // full row; anything else 404s like an unknown id — the guest form stays.
  useEffect(() => {
    if (status !== 'signedIn') return;
    let active = true;
    setChecking(true);
    (async () => {
      const token = await getAccessToken();
      if (!token) {
        if (active) setChecking(false);
        return;
      }
      try {
        const order = await api.getOrder(orderId, { accessToken: token });
        if (!active) return;
        if (order.contactEmail) {
          router.replace(`/orders/${orderId}?email=${encodeURIComponent(order.contactEmail)}`);
        } else {
          setChecking(false);
        }
      } catch {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [status, orderId, getAccessToken, router]);

  if (checking) {
    return (
      <p className="mt-4 text-sm text-stone-500" data-testid="order-verify-checking">
        {t('verifyChecking')}
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const proof = email.trim();
    if (!proof) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.getOrder(orderId, { contactEmail: proof });
      // Correct proof: hand it back to the URL and let the server render the
      // full receipt (the SSR pass sees exactly this query param).
      router.replace(`/orders/${orderId}?email=${encodeURIComponent(proof)}`);
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-stone-200 bg-white p-6 text-left">
      <h2 className="text-sm font-bold">{t('verifyTitle')}</h2>
      <p id="order-verify-hint" className="mt-1 text-xs text-stone-500">
        {t('verifyHint')}
      </p>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <label className="sr-only" htmlFor="order-verify-email">
          {t('verifyEmailLabel')}
        </label>
        <input
          id="order-verify-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-describedby="order-verify-hint"
          className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? t('verifyCheckingBtn') : t('verifyUnlock')}
        </button>
      </form>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-red-600" data-testid="order-verify-failed">
          {t('verifyFailed')}
        </p>
      )}
    </div>
  );
}
