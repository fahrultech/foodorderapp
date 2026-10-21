'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Section switcher shared by the two owner-portal pages (`/dashboard` order
 * inbox and `/dashboard/menu`). Server-side guards still apply on every API
 * call — this is navigation polish, not access control.
 */
export default function PortalTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: '/dashboard', label: '📥 Orders', active: pathname === '/dashboard' },
    { href: '/dashboard/menu', label: '🍳 Menu', active: pathname.startsWith('/dashboard/menu') },
  ];
  return (
    <nav className="mt-4 flex gap-2" aria-label="Portal sections">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? 'page' : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
            t.active
              ? 'bg-brand-600 text-white'
              : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
