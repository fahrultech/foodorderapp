import { api } from '@/lib/api';
import RestaurantCard from '@/components/RestaurantCard';
import { getTranslations } from 'next-intl/server';

export const dynamic = 'force-dynamic';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cuisine?: string }>;
}) {
  const { q, cuisine } = await searchParams;
  const t = await getTranslations('Home');

  let restaurants: Awaited<ReturnType<typeof api.listRestaurants>>['items'] = [];
  let cuisines: string[] = [];
  let apiDown = false;
  try {
    const [list, cs] = await Promise.all([
      api.listRestaurants({ search: q, cuisine }),
      api.cuisines(),
    ]);
    restaurants = list.items;
    cuisines = cs;
  } catch {
    apiDown = true;
  }

  return (
    <div>
      <section className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-stone-500">
          {t('subtitle', { count: cuisines.length || t('many') })}
        </p>
      </section>

      <form className="mb-6 flex flex-wrap items-center gap-3" action="/">
        <input
          name="q"
          defaultValue={q || ''}
          placeholder={t('searchPlaceholder')}
          className="w-full max-w-md rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button className="rounded-xl bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-stone-700">
          {t('search')}
        </button>
      </form>

      {cuisines.length > 0 && (
        <div className="mb-8 flex flex-wrap gap-2">
          {cuisines.map((c) => {
            const active = c === cuisine;
            return (
              <a
                key={c}
                href={`/?cuisine=${encodeURIComponent(c)}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'border-brand-600 bg-brand-600 text-white'
                    : 'border-stone-300 bg-white text-stone-700 hover:border-brand-500 hover:text-brand-600'
                }`}
              >
                {c}
              </a>
            );
          })}
          {(cuisine || q) && (
            <a href="/" className="rounded-full px-4 py-1.5 text-sm font-medium text-stone-500 hover:text-stone-900">
              {t('clear')}
            </a>
          )}
        </div>
      )}

      {apiDown ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">
          <p className="text-lg font-semibold text-stone-700">{t('apiDownTitle')}</p>
          <p className="mt-2 text-sm">
            {t.rich('apiDownBody', {
              api: () => <code className="rounded bg-stone-100 px-1">apps/api</code>,
              docker: () => <code className="rounded bg-stone-100 px-1">docker compose up</code>,
            })}
          </p>
        </div>
      ) : restaurants.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">
          {t('noResults')}
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {restaurants.map((r) => (
            <RestaurantCard key={r.id} restaurant={r} />
          ))}
        </div>
      )}
    </div>
  );
}
