/**
 * Pure open-hours math for the Phase 5 "Restaurant open hours" feature.
 * Everything here is side-effect free and timezone-explicit so it unit-tests
 * deterministically (no reliance on the host clock or the host zone).
 */

/** One weekly window (structural subset of RestaurantHours). */
export interface HoursWindow {
  dayOfWeek: number; // 0 = Sunday ... 6 = Saturday (JS getDay convention)
  opensAt: string; // "HH:MM" 24h
  closesAt: string; // "HH:MM" 24h; <= opensAt means the window wraps past midnight
}

/** "HH:MM" in 24h form. The migration CHECK mirrors this pattern exactly. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const toMinutes = (hhmm: string): number =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** IANA zone validity probe (rejects nonsense before it reaches the DB). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zone used when a restaurant has no explicit `timeZone` (null). */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Local calendar instant of `now` inside `timeZone`. */
export function localParts(
  now: Date,
  timeZone: string,
): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(value('hour')) % 24; // guards the "24" some ICU versions emit
  const minute = Number(value('minute'));
  const day = DAY_INDEX[value('weekday')] ?? 0;
  return { day, minutes: hour * 60 + minute };
}

/** Does a window cover a local minute-of-day? Wraps when closesAt <= opensAt. */
function windowContains(w: HoursWindow, minutes: number): boolean {
  const o = toMinutes(w.opensAt);
  const c = toMinutes(w.closesAt);
  return c > o ? minutes >= o && minutes < c : minutes >= o || minutes < c;
}

const wrapsMidnight = (w: HoursWindow): boolean =>
  toMinutes(w.closesAt) <= toMinutes(w.opensAt);

/**
 * Auto isOpen derivation from a weekly schedule.
 * Returns null for an EMPTY schedule: no signal, the caller must fall back to
 * the legacy manual `isOpen` column. Otherwise true/false for `now` in
 * `timeZone`. Yesterday's wrap-past-midnight window counts for today's
 * early minutes ([opensAt, 24:00) belongs to yesterday's row).
 */
export function isOpenAt(
  rows: HoursWindow[],
  now: Date,
  timeZone: string = serverTimeZone(),
): boolean | null {
  if (!rows.length) return null;
  const { day, minutes } = localParts(now, timeZone);
  for (const w of rows) {
    const shift = (w.dayOfWeek - day + 7) % 7; // 0 = today, 6 = yesterday
    if (shift === 0 && windowContains(w, minutes)) return true;
    if (shift === 6 && wrapsMidnight(w) && minutes < toMinutes(w.closesAt)) {
      return true;
    }
  }
  return false;
}

/** The local day's window (for "Today 08:00-22:00" display), or null. */
export function todayWindow(
  rows: HoursWindow[],
  now: Date,
  timeZone: string = serverTimeZone(),
): HoursWindow | null {
  const { day } = localParts(now, timeZone);
  return rows.find((w) => w.dayOfWeek === day) ?? null;
}
