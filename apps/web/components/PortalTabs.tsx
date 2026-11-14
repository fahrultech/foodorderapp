'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * Section switcher shared by the owner-portal pages. Server-side guards still apply on every API
 * call — this is navigation polish, not access control.
 */
export default function PortalTabs() {
  const pathname = usePathname();
  const t = useTranslations('Portal');
  const tabs = [
    { href: '/dashboard', labelKey: 'tabOrders', active: pathname === '/dashboard' },
    {
      href: '/dashboard/kitchen',
      labelKey: 'tabKitchen',
      active: pathname.startsWith('/dashboard/kitchen'),
    },
    { href: '/dashboard/menu', labelKey: 'tabMenu', active: pathname.startsWith('/dashboard/menu') },
    {
      href: '/dashboard/analytics',
      labelKey: 'tabAnalytics',
      active: pathname.startsWith('/dashboard/analytics'),
    },
  ];
  return (
    <nav className="mt-4 flex gap-2" aria-label={t('tabsNavLabel')}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
            tab.active
              ? 'bg-brand-600 text-white'
              : 'border border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
          }`}
        >
          {t(tab.labelKey)}
        </Link>
      ))}
    </nav>
  );
}
