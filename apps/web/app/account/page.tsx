'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { authedCall } from '@/lib/authed-call';
import { ApiError, api, type AccountDeleteResult } from '@/lib/api';

/**
 * In-app GDPR self-service (the session-63 API endpoints finally get a
 * surface): a full personal-data export downloaded as JSON, and an
 * irreversible account deletion behind a double confirmation.
 *
 * Deletion semantics live server-side (apps/api/src/users/account-data
 * .service.ts): retained order snapshots are anonymized, owned restaurants
 * are detached, refresh sessions cascade-die. The client's only jobs are to
 * clear local state via logout() after a 200 and to never treat a delete-
 * endpoint 401 as an expired token — it is the password check answering.
 * `getAccessToken()` refreshes >60s ahead of expiry, so a fresh-then-deleted
 * token cannot race its own expiry into that 401.
 */

/** Exact destructive-action phrase the API DTO demands (@Equals('DELETE')). */
const CONFIRM_PHRASE = 'DELETE';

export default function AccountPage() {
  const { status, user, getAccessToken, logout } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<AccountDeleteResult | null>(null);

  async function onExport() {
    setExporting(true);
    setExportError(null);
    setExportedFile(null);
    // authedCall owns the rotate-and-retry-on-401 dance for this read.
    const res = await authedCall(getAccessToken, logout, (tok) => api.exportMe(tok));
    if (!res.ok) {
      if (res.kind === 'error') setExportError(res.message);
      // signedOut: the provider cleared the session; the guest card renders.
      setExporting(false);
      return;
    }
    const fileName = `foodorder-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setExportedFile(fileName);
    } catch {
      setExportError('Your browser blocked the download. Allow downloads and try again.');
    } finally {
      setExporting(false);
    }
  }

  async function onDelete(event: React.FormEvent) {
    event.preventDefault();
    setDeleteError(null);
    // Client pre-checks mirror the server's guards for instant feedback;
    // the server stays the authority (it answers 400/401 for anything else).
    if (!password) {
      setDeleteError('Enter your current password.');
      return;
    }
    if (confirmation !== CONFIRM_PHRASE) {
      setDeleteError(`Type ${CONFIRM_PHRASE} exactly to confirm.`);
      return;
    }
    const token = await getAccessToken();
    if (!token) return; // guest mid-flight; the guest card takes over.
    setDeleting(true);
    let result: AccountDeleteResult;
    try {
      result = await api.deleteMe(token, { password, confirmation: CONFIRM_PHRASE });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not reach the API.');
      setDeleting(false);
      return;
    }
    // Server-side sessions are already cascade-dead; this clears the local
    // copy (its best-effort /auth/logout call 401s quietly and is ignored).
    // Even a throw here must not hide the fact that the DELETE succeeded.
    try {
      await logout();
    } catch {
      /* fall through to the deleted state regardless */
    }
    setDeleted(result);
    setDeleting(false);
  }

  if (deleted) {
    return (
      <section data-testid="account-deleted">
        <h1 className="text-2xl font-bold">Account deleted</h1>
        <p className="mt-3 text-stone-600">
          Your account and its personal data are gone, and you have been signed out on every
          device. Order history that restaurants and couriers still need for their records was
          kept but anonymized — it no longer names or contacts you.
        </p>
        <p className="mt-2 text-sm text-stone-500">
          {deleted.anonymizedOrders} retained order{deleted.anonymizedOrders === 1 ? '' : 's'}{' '}
          anonymized{deleted.detachedRestaurants > 0 ? `, ${deleted.detachedRestaurants} restaurant(s) detached` : ''}
          {deleted.unassignedOrders > 0 ? `, ${deleted.unassignedOrders} delivery assignment(s) released` : ''}.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Back to restaurants
        </Link>
      </section>
    );
  }

  if (status === 'guest') {
    return (
      <section>
        <h1 className="text-2xl font-bold">Account & privacy</h1>
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">Sign in to manage your data.</p>
          <p className="mt-1 text-sm text-stone-500">
            Export everything we hold about you, or delete your account outright.
          </p>
          <Link
            href="/login?next=%2Faccount"
            className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-bold">Account &amp; privacy</h1>
      {user && (
        <p className="mt-1 text-sm text-stone-500" title={user.email}>
          Signed in as <span className="font-semibold text-stone-700">{user.name}</span> (
          {user.email})
        </p>
      )}

      {/* --- data export --- */}
      <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-6" data-testid="account-export-card">
        <h2 className="text-lg font-bold text-stone-800">Download your data</h2>
        <p className="mt-1 text-sm text-stone-600">
          A single JSON file with everything this account holds: profile, saved addresses,
          favorites, orders, payments, reviews, restaurants you own, delivery work, active
          sessions and notification devices. Passwords and token secrets are never included.
        </p>
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={status !== 'signedIn' || exporting}
          aria-busy={exporting}
          data-testid="account-export-button"
          className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
        >
          {exporting ? 'Preparing export…' : 'Download my data'}
        </button>
        {exportedFile && (
          <p role="status" data-testid="account-export-done" className="mt-3 text-sm font-medium text-emerald-700">
            Export ready — check your downloads for {exportedFile}.
          </p>
        )}
        {exportError && (
          <p role="alert" data-testid="account-export-error" className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {exportError}
          </p>
        )}
      </div>

      {/* --- danger zone --- */}
      <div className="mt-8 rounded-2xl border border-red-200 bg-red-50/40 p-6" data-testid="account-delete-card">
        <h2 className="text-lg font-bold text-red-800">Delete your account</h2>
        <p className="mt-1 text-sm text-stone-600">
          This is irreversible and signs you out everywhere immediately. Your saved addresses,
          favorites and sessions are erased; order records restaurants must keep stay on file
          with your name and contact details replaced by &ldquo;Deleted user&rdquo;. If you own a
          restaurant with active orders or drive open deliveries, resolve them first — the server
          will refuse the deletion until you do.
        </p>
        <form onSubmit={(e) => void onDelete(e)} className="mt-4 space-y-4" data-testid="account-delete-form">
          <div>
            <label htmlFor="delete-password" className="block text-sm font-semibold text-stone-700">
              Current password
            </label>
            <input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-base"
            />
          </div>
          <div>
            <label htmlFor="delete-confirmation" className="block text-sm font-semibold text-stone-700">
              Type <span className="font-mono">DELETE</span> to confirm
            </label>
            <input
              id="delete-confirmation"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="mt-1 w-full rounded-xl border border-stone-300 px-3 py-2 text-base"
            />
          </div>
          <button
            type="submit"
            disabled={deleting}
            aria-busy={deleting}
            data-testid="account-delete-button"
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-wait disabled:opacity-60"
          >
            {deleting ? 'Deleting…' : 'Delete my account'}
          </button>
        </form>
        {deleteError && (
          <p role="alert" data-testid="account-delete-error" className="mt-3 rounded-xl bg-red-100 px-4 py-3 text-sm font-medium text-red-800">
            {deleteError}
          </p>
        )}
      </div>
    </section>
  );
}
