import Link from 'next/link';

export default function OfflinePage() {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-stone-200 bg-white p-10 text-center">
      <p className="text-3xl" aria-hidden="true">
        📡
      </p>
      <h1 className="mt-3 text-2xl font-extrabold">You are offline</h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">
        Previously visited storefront pages may still be available. Your saved cart stays on this
        device and can be reviewed or edited without a connection.
      </p>
      <Link
        href="/cart"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Open saved cart
      </Link>
    </div>
  );
}
