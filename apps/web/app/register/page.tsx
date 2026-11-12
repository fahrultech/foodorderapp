'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

type FieldKey = 'name' | 'email' | 'password' | 'confirm' | 'phone' | 'address';

/** DOM order of the fields — also the "focus the first invalid one" order. */
const FIELD_ORDER: FieldKey[] = ['name', 'email', 'password', 'confirm', 'phone', 'address'];

/**
 * Client-side mirrors of the API RegisterDto constraints (class-validator).
 * a11y pass #2 (session 81): errors are keyed BY FIELD so each message can
 * render inline next to its control (role=alert + aria-describedby +
 * aria-invalid), instead of one aggregated list a screen reader has to
 * mentally map back onto the inputs.
 */
function validate(form: Record<FieldKey, string>): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  const name = form.name.trim();
  if (name.length < 2 || name.length > 120) errors.name = 'Name must be 2–120 characters.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = 'Enter a valid email address.';
  if (form.password.length < 8 || form.password.length > 200)
    errors.password = 'Password must be at least 8 characters.';
  if (form.password !== form.confirm) errors.confirm = 'Passwords do not match.';
  if (form.phone.trim().length > 30) errors.phone = 'Phone must be at most 30 characters.';
  if (form.address.trim().length > 500) errors.address = 'Address must be at most 500 characters.';
  return errors;
}

/**
 * Inline per-field error. Defined at MODULE level on purpose: a component
 * declared inside RegisterPage gets a new identity every render, which would
 * remount the alert node and make assistive tech re-announce it while the
 * user is still typing. Same node, stable text = announced once.
 */
function FieldError({ k, msg }: { k: FieldKey; msg?: string }) {
  if (!msg) return null;
  return (
    <p role="alert" id={`${k}-error`} className="mt-1 text-xs font-medium text-red-600">
      {msg}
    </p>
  );
}

export default function RegisterPage() {
  const router = useRouter();
  const { register, status } = useAuth();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirm: '',
    phone: '',
    address: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'signedIn') router.replace('/');
  }, [status, router]);

  const field =
    'w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problems = validate(form);
    setFieldErrors(problems);
    setServerError(null);
    const firstInvalid = FIELD_ORDER.find((k) => problems[k]);
    if (firstInvalid) {
      // Focus lands on the field the user must fix first — the alert next
      // to it is announced, but a sighted keyboard user gets the caret
      // where it belongs without tab-hunting.
      document.getElementById(firstInvalid)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await register({
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone,
        address: form.address,
      });
      router.replace('/');
    } catch (err: any) {
      // Server-side truth (the client mirrors are best-effort): map the API
      // error envelope onto the top of the form as a role=alert.
      setServerError(err?.message || 'Could not create the account');
      setSubmitting(false);
    }
  }

  /** Per-field inline error wiring (session 81 a11y pass). */
  function fieldProps(k: FieldKey) {
    const msg = fieldErrors[k];
    return {
      'aria-invalid': msg ? true : undefined,
      'aria-describedby': msg ? `${k}-error` : undefined,
    };
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-extrabold">Create your account</h1>
      <p className="mt-1 text-sm text-stone-500">
        Takes a few seconds — you will be signed in right away.
      </p>
      <form
        onSubmit={submit}
        noValidate
        className="mt-6 space-y-4 rounded-2xl border border-stone-200 bg-white p-6"
      >
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            required
            autoComplete="name"
            className={field}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Jane Doe"
            {...fieldProps('name')}
          />
          <FieldError k="name" msg={fieldErrors.name} />
        </div>
        <div>
          <label htmlFor="email" className="mb-1 block text-sm font-medium">
            Email
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
            {...fieldProps('email')}
          />
          <FieldError k="email" msg={fieldErrors.email} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="new-password"
              className={field}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="min. 8 characters"
              {...fieldProps('password')}
            />
            <FieldError k="password" msg={fieldErrors.password} />
          </div>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-medium">
              Confirm password
            </label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              className={field}
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              placeholder="repeat it"
              {...fieldProps('confirm')}
            />
            <FieldError k="confirm" msg={fieldErrors.confirm} />
          </div>
        </div>
        <div>
          <label htmlFor="phone" className="mb-1 block text-sm font-medium">
            Phone <span className="text-stone-400">(optional)</span>
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            className={field}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="+62 812 3456 7890"
            {...fieldProps('phone')}
          />
          <FieldError k="phone" msg={fieldErrors.phone} />
        </div>
        <div>
          <label htmlFor="address" className="mb-1 block text-sm font-medium">
            Delivery address <span className="text-stone-400">(optional)</span>
          </label>
          <textarea
            id="address"
            rows={2}
            autoComplete="street-address"
            className={field}
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="Street, number, city…"
            {...fieldProps('address')}
          />
          <FieldError k="address" msg={fieldErrors.address} />
        </div>
        {serverError && (
          <div role="alert" id="server-error" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {serverError}
          </div>
        )}
        <button
          disabled={submitting}
          className="w-full rounded-xl bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-stone-300"
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
        <p className="text-center text-sm text-stone-500">
          Already registered?{' '}
          <Link href="/login" className="font-semibold text-brand-600 hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
