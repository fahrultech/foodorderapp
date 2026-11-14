import type { Order } from '@/lib/api';
import { useLocale, useTranslations } from 'next-intl';

/**
 * Customer-facing tracking timeline (Phase 3). Pure presentation of the
 * status-step timestamps the API stamps on the order entity: 'Placed' is
 * `createdAt`, later steps carry their own `*At` column and stay empty
 * ("waiting") until the order actually reaches them. A cancelled order gets
 * a red terminal node after whatever steps it had already reached.
 */

interface Step {
  key: string;
  label: string;
  sub: string;
  at: string | null;
}

// App locale → CLDR tag for the step timestamps; 'en' keeps the historical
// en-US rendering byte-identical (session 94 storefront i18n sweep).
function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default function OrderTimeline({ order }: { order: Order }) {
  const t = useTranslations('Order');
  const locale = useLocale();
  const cancelled = order.status === 'cancelled';
  const steps: Step[] = [
    { key: 'pending', label: t('tlPlaced'), sub: t('tlPlacedSub'), at: order.createdAt ?? null },
    { key: 'confirmed', label: t('tlConfirmed'), sub: t('tlConfirmedSub'), at: order.confirmedAt ?? null },
    { key: 'preparing', label: t('tlPreparing'), sub: t('tlPreparingSub'), at: order.preparingAt ?? null },
    { key: 'delivering', label: t('tlOnTheWay'), sub: t('tlOnTheWaySub'), at: order.deliveringAt ?? null },
    { key: 'completed', label: t('tlDelivered'), sub: t('tlDeliveredSub'), at: order.completedAt ?? null },
  ];
  if (cancelled) {
    steps.push({ key: 'cancelled', label: t('tlCancelled'), sub: t('tlCancelledSub'), at: order.cancelledAt ?? null });
  }

  const reachedCount = steps.filter((s) => s.at).length;
  // The "waiting" pulse sits on the first not-yet-reached step, and only for
  // live (non-cancelled, non-completed) orders — a finished timeline needs no
  // pulse, and a cancelled one ends on the red node.
  const waitingKey =
    !cancelled && order.status !== 'completed'
      ? steps.find((s) => !s.at)?.key ?? null
      : null;

  return (
    <ol className="relative mt-4">
      {steps.map((step, i) => {
        const done = !!step.at;
        const isWaiting = step.key === waitingKey;
        const last = i === steps.length - 1;
        return (
          <li key={step.key} className={`relative flex gap-4 ${last ? '' : 'pb-6'}`}>
            {!last && (
              <span
                aria-hidden
                className={`absolute left-[7px] top-4 h-full w-0.5 ${done ? 'bg-emerald-300' : 'bg-stone-200'}`}
              />
            )}
            <span aria-hidden className="relative z-10 mt-0.5 shrink-0">
              {done ? (
                <span className="block h-4 w-4 rounded-full bg-emerald-500 ring-4 ring-emerald-100">
                  <svg viewBox="0 0 16 16" className="h-4 w-4 text-white" fill="currentColor" aria-hidden>
                    <path d="M13.3 4.3a1 1 0 0 1 0 1.4l-5.6 5.6a1 1 0 0 1-1.4 0L3.7 8.3a1 1 0 1 1 1.4-1.4l1.9 1.9 4.9-4.9a1 1 0 0 1 1.4 0Z" />
                  </svg>
                </span>
              ) : isWaiting ? (
                <span className="relative block h-4 w-4">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60" />
                  <span className="relative block h-4 w-4 rounded-full border-2 border-amber-400 bg-white" />
                </span>
              ) : (
                <span className="block h-4 w-4 rounded-full border-2 border-stone-200 bg-white" />
              )}
            </span>
            <div className="flex flex-1 items-baseline justify-between gap-3" aria-current={isWaiting ? 'step' : undefined}>
              <div>
                <p className={`text-sm font-semibold ${done ? 'text-stone-800' : step.key === 'cancelled' ? 'text-rose-700' : 'text-stone-400'}`}>
                  {step.label}
                  {step.key === 'cancelled' && done && (
                    <span className="ml-1 text-rose-700">✕</span>
                  )}
                </p>
                <p className="text-xs text-stone-400">{step.sub}</p>
              </div>
              <p className={`shrink-0 text-xs font-medium tabular-nums ${done ? 'text-stone-600' : 'text-stone-300'}`}>
                {step.at ? formatTime(step.at, locale) : isWaiting ? t('tlWaiting') : '—'}
              </p>
            </div>
          </li>
        );
      })}
      <p className="sr-only">
        {cancelled
          ? t('srCancelled')
          : t('srSteps', { done: String(reachedCount), total: String(steps.length) })}
      </p>
    </ol>
  );
}
