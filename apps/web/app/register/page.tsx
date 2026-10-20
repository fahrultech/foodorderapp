'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

/** Client-side mirrors of the API RegisterDto constraints (class-validator). */
function validate(form: {
  name: string;
  email: string;
  password: string;
  confirm: string;
  phone: string;
  address: string;
}): string[] {
  const errors: string[] = [];
  const name = form.name.trim();
  if (name.length < 2 || name.length > 120) errors.push('Name must be 2–120 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.push('Enter a valid email address.');
  if (form.password.length < 8 || form.password.length > 200)
    errors.push('Password must be at least 8 characters.');
  if (form.password !== form.confirm) errors.push('Passwords do not match.');
  if (form.phone.trim().length > 30) errors.push('Phone must be at most 30 characters.');
  if (form.address.trim().length > 500) errors.push('Address must be at most 500 characters.');
  return errors;
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
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === 'signedIn') router.replace('/');
  }, [status, router]);

  const field =
    'w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problems = validate(form);
    setErrors(problems);
    if (problems.length) return;
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
      // Map the API error envelope onto the form (ApiError.details carries
      // per-field constraints when validation failed server-side).
      const message = err?.message || 'Could not create the account';
      setErrors([message]);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-2xl font-extrabold">Create your account</h1>
      <p className="mt-1 text-sm text-stone-500">
        Takes a few seconds — you will be signed in right away.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-stone-200 bg-white p-6">
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
          />
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
          />
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
              minLength={8}
              autoComplete="new-password"
              className={field}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="min. 8 characters"
            />
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
            />
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
          />
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
          />
        </div>
        {errors.length > 0 && (
          <div role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            <ul className="list-inside list-disc space-y-1">
              {errors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
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
