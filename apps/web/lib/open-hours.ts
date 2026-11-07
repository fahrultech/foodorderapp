import type { RestaurantHour } from './api';

/**
 * Storefront-side mirror of the API's open-hours derivation (session 68).
 * ONLY used to render "today HH:MM-HH:MM"; the authoritative open/closed
 * signal is the server-derived `isOpenNow`, which this file deliberately
 * does not recompute.
 */

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Local weekday (0 = Sunday) of `now` inside `timeZone`. */
export function localDayOfWeek(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return DAY_INDEX[weekday] ?? 0;
}

/**
 * Today's window for display, in the restaurant's zone (null when the
 * restaurant has no weekly schedule — the legacy manual toggle path).
 */
export function todayWindow(
  hours: RestaurantHour[] | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): RestaurantHour | null {
  if (!hours || hours.length === 0) return null;
  const day = localDayOfWeek(now, timeZone ?? serverZone());
  return hours.find((h) => h.dayOfWeek === day) ?? null;
}
