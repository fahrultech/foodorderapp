'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth';
import { engageNavGate, releaseNavGate } from '@/lib/nav-gate';

/**
 * Only same-origin relative paths are safe to redirect into — `//host` and
 * `/\host` are browser-relative redirects an attacker could abuse.
 */
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('\\') ? raw : '/';
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, status } = useAuth();
  const t = useTranslations('Auth');
  const h = useTranslations('Header');
  const c = useTranslations('Common');
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = safeNext(searchParams.get('next'));

  // The gate's normal release IS this unmount: it only happens when a
  // redirect from this form committed. (No-gate unmounts release a no-op.)
  useEffect(() => () => releaseNavGate(), []);

  // Already signed in? Skip the form. Engage before dispatching so the
  // hydration-flip → commit window cannot host a swallowable click either.
  useEffect(() => {
    if (status === 'signedIn') {
      engageNavGate();
      router.replace(next);
    }
  }, [status, router, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    // Gate from the FIRST moment of the submit: guest-view nav links could
    // otherwise start a navigation while the auth request is in flight and
    // get dragged over by the redirect that follows it.
    engageNavGate();
    try {
      await login(form.email, form.password);
      // A slow auth round-trip may have tripped the safety timer mid-flight —
      // re-engage synchronously with the redirect dispatch.
      engageNavGate();
      router.replace(next);
    } catch (err: any) {
      // Failed login keeps the user on /login — hand the nav back.
      releaseNavGate();
      setError(err?.message || t('signInError'));
      setSubmitting(false);
    }
  }

  const field =
    'w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-extrabold">{h('signIn')}</h1>
      <p className="mt-1 text-sm text-stone-500">{t('signInSubtitle')}</p>
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-stone-200 bg-white p-6">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            {c('email')}
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className={field}
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm font-medium">
            {c('password')}
          </label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            className={field}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="••••••••"
          />
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <button
          disabled={submitting}
          className="w-full rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
        >
          {submitting ? t('signingIn') : h('signIn')}
        </button>
        <p className="text-center text-sm text-stone-500">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-semibold text-brand-600 hover:underline">
            {t('createOne')}
          </Link>
        </p>
        <p className="rounded-xl bg-stone-50 px-4 py-3 text-center text-xs text-stone-500">
          {t('demoLogin')} <span className="font-mono">demo@foodorder.app</span> /{' '}
          <span className="font-mono">demo1234</span>
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  const c = useTranslations('Common');
  return (
    <Suspense fallback={<div className="mx-auto max-w-md text-sm text-stone-500">{c('loading')}</div>}>
      <LoginForm />
    </Suspense>
  );
}
