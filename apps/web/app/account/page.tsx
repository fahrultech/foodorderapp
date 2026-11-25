'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { authedCall } from '@/lib/authed-call';
import { ApiError, api, type AccountDeleteResult, type NotificationSettings } from '@/lib/api';

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
  const t = useTranslations('Account');
  const th = useTranslations('Header');
  const [exporting, setExporting] = useState(false);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<AccountDeleteResult | null>(null);

  // --- notification channel toggles (session 131 surface of session 130's API) ---
  /** Last PERSISTED state (GET or PATCH reply); null until the first read lands. */
  const [notify, setNotify] = useState<NotificationSettings | null>(null);
  const [notifyLoading, setNotifyLoading] = useState(true);
  const [notifyLoadError, setNotifyLoadError] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifySaveError, setNotifySaveError] = useState<string | null>(null);
  /** Label of the channel whose last write persisted (transient role=status). */
  const [savedChannel, setSavedChannel] = useState<string | null>(null);

  const loadNotificationSettings = useCallback(async () => {
    setNotifyLoading(true);
    setNotifyLoadError(null);
    const res = await authedCall(getAccessToken, logout, (tok) => api.getNotificationSettings(tok));
    if (res.ok) setNotify(res.data);
    else if (res.kind === 'error') setNotifyLoadError(res.message);
    // signedOut: the provider cleared the session; the guest card takes over.
    setNotifyLoading(false);
  }, [getAccessToken, logout]);

  useEffect(() => {
    if (status !== 'signedIn') return;
    // Never show a previous session's checkboxes mid-refetch.
    setNotify(null);
    void loadNotificationSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function onToggleChannel(field: keyof NotificationSettings, next: boolean) {
    if (notifyBusy) return;
    setNotifyBusy(true);
    setNotifySaveError(null);
    setSavedChannel(null);
    const res = await authedCall(getAccessToken, logout, (tok) =>
      api.updateNotificationSettings(tok, { [field]: next }),
    );
    if (res.ok) {
      // The reply is the re-read persisted row — replace the WHOLE copy,
      // not just the clicked field (a racing write elsewhere shows up).
      setNotify(res.data);
      setSavedChannel(field === 'orderEmail' ? t('notifyEmailLabel') : t('notifyPushLabel'));
    } else if (res.kind === 'error') {
      // No optimistic local write was made: the checkboxes are controlled
      // off the last persisted state, so a failed write SELF-REVERTS.
      setNotifySaveError(res.message);
    }
    setNotifyBusy(false);
  }

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
      setExportError(t('browserBlocked'));
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
      setDeleteError(t('errPasswordRequired'));
      return;
    }
    if (confirmation !== CONFIRM_PHRASE) {
      setDeleteError(t('errConfirmPhrase', { phrase: CONFIRM_PHRASE }));
      return;
    }
    const token = await getAccessToken();
    if (!token) return; // guest mid-flight; the guest card takes over.
    setDeleting(true);
    let result: AccountDeleteResult;
    try {
      result = await api.deleteMe(token, { password, confirmation: CONFIRM_PHRASE });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t('apiUnreachable'));
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
        <h1 className="text-2xl font-bold">{t('deletedTitle')}</h1>
        <p className="mt-3 text-stone-600">
          {t('deletedBody')}
        </p>
        <p className="mt-2 text-sm text-stone-500">
          {t('deletedOrders', { count: deleted.anonymizedOrders })}
          {deleted.detachedRestaurants > 0
            ? t('detachedSuffix', { count: String(deleted.detachedRestaurants) })
            : ''}
          {deleted.unassignedOrders > 0
            ? t('releasedSuffix', { count: String(deleted.unassignedOrders) })
            : ''}
          .
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          {t('backCta')}
        </Link>
      </section>
    );
  }

  if (status === 'guest') {
    return (
      <section>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-stone-50 p-10 text-center">
          <p className="text-lg font-semibold text-stone-700">{t('gateTitle')}</p>
          <p className="mt-1 text-sm text-stone-500">
            {t('gateBody')}
          </p>
          <Link
            href="/login?next=%2Faccount"
            className="mt-4 inline-block rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
          >
            {th('signIn')}
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {user && (
        <p className="mt-1 text-sm text-stone-500" title={user.email}>
          {t('signedInAs')} <span className="font-semibold text-stone-700">{user.name}</span> (
          {user.email})
        </p>
      )}

      {/* --- data export --- */}
      <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-6" data-testid="account-export-card">
        <h2 className="text-lg font-bold text-stone-800">{t('exportTitle')}</h2>
        <p className="mt-1 text-sm text-stone-600">
          {t('exportBody')}
        </p>
        <button
          type="button"
          onClick={() => void onExport()}
          disabled={status !== 'signedIn' || exporting}
          aria-busy={exporting}
          data-testid="account-export-button"
          className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-60"
        >
          {exporting ? t('exporting') : t('exportCta')}
        </button>
        {exportedFile && (
          <p role="status" data-testid="account-export-done" className="mt-3 text-sm font-medium text-emerald-700">
            {t('exportDone', { file: exportedFile })}
          </p>
        )}
        {exportError && (
          <p role="alert" data-testid="account-export-error" className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {exportError}
          </p>
        )}
      </div>

      {/* --- notification channels --- */}
      <div className="mt-8 rounded-2xl border border-stone-200 bg-white p-6" data-testid="account-notify-card">
        <h2 className="text-lg font-bold text-stone-800">{t('notifyTitle')}</h2>
        <p className="mt-1 text-sm text-stone-600">
          {t('notifyBody')}
        </p>

        {notifyLoading ? (
          <p data-testid="account-notify-loading" aria-busy="true" className="mt-4 text-sm text-stone-500">
            {t('notifyLoading')}
          </p>
        ) : notify ? (
          <div className="mt-4 space-y-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={notify.orderEmail}
                disabled={notifyBusy}
                onChange={(e) => void onToggleChannel('orderEmail', e.target.checked)}
                data-testid="account-notify-email"
                className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300"
              />
              <span>
                <span className="block text-sm font-semibold text-stone-700">{t('notifyEmailLabel')}</span>
                <span className="block text-xs text-stone-500">{t('notifyEmailHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={notify.orderPush}
                disabled={notifyBusy}
                onChange={(e) => void onToggleChannel('orderPush', e.target.checked)}
                data-testid="account-notify-push"
                className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300"
              />
              <span>
                <span className="block text-sm font-semibold text-stone-700">{t('notifyPushLabel')}</span>
                <span className="block text-xs text-stone-500">{t('notifyPushHint')}</span>
              </span>
            </label>
          </div>
        ) : (
          <div className="mt-4">
            <p role="alert" data-testid="account-notify-load-error" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {notifyLoadError ?? t('notifyLoadFailed')}
            </p>
            <button
              type="button"
              onClick={() => void loadNotificationSettings()}
              data-testid="account-notify-retry"
              className="mt-3 rounded-xl border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t('notifyRetry')}
            </button>
          </div>
        )}

        {savedChannel && (
          <p role="status" data-testid="account-notify-saved" className="mt-3 text-sm font-medium text-emerald-700">
            {t('notifySaved', { item: savedChannel })}
          </p>
        )}
        {notifySaveError && (
          <p role="alert" data-testid="account-notify-save-error" className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {notifySaveError}
          </p>
        )}
      </div>

      {/* --- danger zone --- */}
      <div className="mt-8 rounded-2xl border border-red-200 bg-red-50/40 p-6" data-testid="account-delete-card">
        <h2 className="text-lg font-bold text-red-800">{t('deleteTitle')}</h2>
        <p className="mt-1 text-sm text-stone-600">
          {t('deleteBody')}
        </p>
        <form onSubmit={(e) => void onDelete(e)} className="mt-4 space-y-4" data-testid="account-delete-form">
          <div>
            <label htmlFor="delete-password" className="block text-sm font-semibold text-stone-700">
              {t('passwordLabel')}
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
              {t('confirmPrefix')} <span className="font-mono">DELETE</span> {t('confirmSuffix')}
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
            {deleting ? t('deleting') : t('deleteCta')}
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
