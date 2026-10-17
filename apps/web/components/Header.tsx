'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCart } from '@/lib/cart';

export default function Header() {
  const { count } = useCart();
  const pathname = usePathname();
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
            Restaurants
          </Link>
          <Link
            href="/cart"
            className="relative rounded-full bg-brand-600 px-4 py-2 font-semibold text-white hover:bg-brand-700"
          >
            Cart
            {count > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-stone-900 px-1 text-xs font-bold text-white">
                {count}
              </span>
            )}
          </Link>
        </nav>
      </div>
    </header>
  );
}
