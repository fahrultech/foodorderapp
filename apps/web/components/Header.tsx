'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart';
import { useAuth } from '@/lib/auth';
import { usePushNotifications } from '@/lib/push-notifications';
import PushNotificationButton from '@/components/PushNotificationButton';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import type { AppLocale } from '@/i18n/request';
import { useTranslations } from 'next-intl';

export default function Header({
  changeLocaleAction,
}: {
  changeLocaleAction: (locale: AppLocale) => Promise<void>;
}) {
  const t = useTranslations('Header');
  const { count } = useCart();
  const { status, user, logout } = useAuth();
  const { disconnectBeforeLogout } = usePushNotifications();
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await disconnectBeforeLogout();
    await logout();
    // Back to a neutral page: history/cart are guest-visible anyway.
    router.push('/');
  }

  return (
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 text-xl font-bold text-brand-600">
          <span aria-hidden>🍜</span> FoodOrder
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/"
            className={pathname === '/' ? 'font-semibold text-brand-600' : 'text-stone-600 hover:text-stone-900'}
          >
            {t('restaurants')}
          </Link>
          {/* 'loading' renders nothing on server AND first client paint -> hydration-safe. */}
          {status === 'loading' && <span className="h-9 w-20 rounded-full bg-stone-100" aria-hidden />}
          {status === 'guest' && (
            <>
              <Link
                href="/login"
                className="rounded-full px-4 py-2 font-semibold text-stone-700 hover:bg-stone-100"
              >
                {t('signIn')}
              </Link>
              <Link
                href="/register"
                className="rounded-full border border-brand-600 px-4 py-2 font-semibold text-brand-600 hover:bg-brand-50"
              >
                {t('register')}
              </Link>
            </>
          )}
          {status === 'signedIn' && user && (
            <>
              {(user.role === 'owner' || user.role === 'admin') && (
                <Link
                  href="/dashboard"
                  className={pathname.startsWith('/dashboard') ? 'font-semibold text-brand-600' : 'text-stone-600 hover:text-stone-900'}
                >
                  {t('dashboard')}
                </Link>
              )}
              <Link
                href="/favorites"
                className={pathname.startsWith('/favorites') ? 'font-semibold text-brand-600' : 'text-stone-600 hover:text-stone-900'}
              >
                {t('saved')}
              </Link>
              <Link
                href="/addresses"
                className={pathname.startsWith('/addresses') ? 'font-semibold text-brand-600' : 'hidden text-stone-600 hover:text-stone-900 lg:inline'}
              >
                {t('addresses')}
              </Link>
              <Link
                href="/orders/my"
                className={pathname.startsWith('/orders') ? 'font-semibold text-brand-600' : 'text-stone-600 hover:text-stone-900'}
              >
                {t('myOrders')}
              </Link>
              <span className="hidden items-center gap-1.5 sm:flex" title={user.email}>
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700"
                >
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="font-semibold text-stone-800">{user.name}</span>
              </span>
              <PushNotificationButton />
              <button
                onClick={signOut}
                className="rounded-full px-4 py-2 font-semibold text-stone-600 hover:bg-stone-100"
              >
                {t('signOut')}
              </button>
            </>
          )}
          <Link
            href="/cart"
            className="relative rounded-full bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
          >
            {t('cart')}
            {count > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-stone-900 px-1 text-xs font-bold text-white">
                {count}
              </span>
            )}
          </Link>
          <LocaleSwitcher changeLocaleAction={changeLocaleAction} />
        </nav>
      </div>
    </header>
  );
}
