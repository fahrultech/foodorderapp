import {
  isOpenAt,
  isValidTimeZone,
  localParts,
  toMinutes,
  todayWindow,
  TIME_RE,
} from './open-hours';

const TZ = 'Asia/Jakarta'; // UTC+7, no DST — arithmetic verifiable by hand.

describe('open-hours — TIME_RE + toMinutes', () => {
  it('accepts only HH:MM 24h forms', () => {
    expect(TIME_RE.test('07:00')).toBe(true);
    expect(TIME_RE.test('23:59')).toBe(true);
    expect(TIME_RE.test('00:00')).toBe(true);
    for (const bad of ['8:00', '24:00', '07:60', '17:5', '0700', '07:0a']) {
      expect(TIME_RE.test(bad)).toBe(false);
    }
  });
  it('converts HH:MM to minutes-of-day', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('07:05')).toBe(425);
    expect(toMinutes('23:59')).toBe(1439);
  });
});

describe('open-hours — isValidTimeZone', () => {
  it('accepts real IANA zones and rejects nonsense', () => {
    expect(isValidTimeZone('Asia/Jakarta')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });
});

describe('open-hours — localParts', () => {
  it('maps an instant to the local weekday + minute-of-day in the zone', () => {
    // 2026-11-07 is a SATURDAY. 05:30Z = 12:30 WIB, same calendar day.
    expect(localParts(new Date('2026-11-07T05:30:00Z'), TZ)).toEqual({
      day: 6,
      minutes: 12 * 60 + 30,
    });
    // 2026-11-08T00:30Z = 07:30 SUN (calendar day rolls in the zone).
    expect(localParts(new Date('2026-11-08T00:30:00Z'), TZ)).toEqual({
      day: 0,
      minutes: 7 * 60 + 30,
    });
    // Same instant reads differently under a different zone.
    expect(localParts(new Date('2026-11-08T00:30:00Z'), 'UTC')).toEqual({
      day: 0,
      minutes: 30,
    });
  });
});

describe('open-hours — isOpenAt', () => {
  const sat = (hhmmZ: string) => new Date(hhmmZ);

  it('returns NULL for an empty schedule (caller falls back to manual isOpen)', () => {
    expect(isOpenAt([], sat('2026-11-07T05:30:00Z'), TZ)).toBeNull();
  });

  it('normal window is [opensAt, closesAt)', () => {
    const rows = [
      { dayOfWeek: 6, opensAt: '07:00', closesAt: '23:00' }, // Saturday only
    ];
    expect(isOpenAt(rows, sat('2026-11-07T00:00:00Z'), TZ)).toBe(true); // 07:00 WIB — opensAt boundary INCLUSIVE
    expect(isOpenAt(rows, sat('2026-11-06T23:59:00Z'), TZ)).toBe(false); // 06:59 WIB
    expect(isOpenAt(rows, sat('2026-11-07T05:30:00Z'), TZ)).toBe(true); // 12:30 WIB
    expect(isOpenAt(rows, sat('2026-11-07T16:00:00Z'), TZ)).toBe(false); // 23:00 WIB — exclusive end
    expect(isOpenAt(rows, sat('2026-11-07T15:59:00Z'), TZ)).toBe(true); // 22:59 WIB
  });

  it('a weekday without a row is closed (absence = closed, no yesterday spill)', () => {
    // Tue-Sun 11:00-21:00: Monday (day 1) has no row.
    const rows = [0, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      opensAt: '11:00',
      closesAt: '21:00',
    }));
    expect(isOpenAt(rows, new Date('2026-11-09T05:00:00Z'), TZ)).toBe(false); // Mon 12:00 WIB
    expect(isOpenAt(rows, new Date('2026-11-08T05:00:00Z'), TZ)).toBe(true); // Sun 12:00 WIB
  });

  it('closesAt <= opensAt wraps past midnight: late minutes AND early next-day minutes', () => {
    // Night stall 17:00 -> 02:00 next day, every day.
    const rows = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d,
      opensAt: '17:00',
      closesAt: '02:00',
    }));
    // Wed 2026-11-11 01:30 WIB (= Nov 10 18:30Z): yesterday (Tue) wrap window.
    expect(isOpenAt(rows, new Date('2026-11-10T18:30:00Z'), TZ)).toBe(true);
    // Wed 03:00 WIB: past the wrapped 02:00 end and before 17:00 — closed.
    expect(isOpenAt(rows, new Date('2026-11-10T20:00:00Z'), TZ)).toBe(false);
    // Wed 18:00 WIB (= Nov 11 11:00Z): today's window opened at 17:00.
    expect(isOpenAt(rows, new Date('2026-11-11T11:00:00Z'), TZ)).toBe(true);
  });

  it("Sunday 00:30 inherits a wrapping Saturday row (day-of-week wraps too)", () => {
    const rows = [{ dayOfWeek: 6, opensAt: '22:00', closesAt: '01:00' }];
    // Sun 2026-11-08 00:30 WIB (= Nov 7 17:30Z).
    expect(isOpenAt(rows, new Date('2026-11-07T17:30:00Z'), TZ)).toBe(true);
    // Sun 01:30 WIB: exactly one hour past the wrapped end.
    expect(isOpenAt(rows, new Date('2026-11-07T18:30:00Z'), TZ)).toBe(false);
  });

  it('a non-wrapping yesterday never spills into today', () => {
    const rows = [
      { dayOfWeek: 6, opensAt: '08:00', closesAt: '22:00' }, // Sat only
      { dayOfWeek: 0, opensAt: '10:00', closesAt: '14:00' }, // Sun only
    ];
    // Sun 09:00 WIB: Saturday closed 22:00, Sunday not open yet.
    expect(isOpenAt(rows, new Date('2026-11-08T02:00:00Z'), TZ)).toBe(false);
    // Sun 12:00 WIB inside Sunday's window.
    expect(isOpenAt(rows, new Date('2026-11-08T05:00:00Z'), TZ)).toBe(true);
  });
});

describe('open-hours — todayWindow', () => {
  const rows = [
    { dayOfWeek: 6, opensAt: '07:00', closesAt: '23:00' },
    { dayOfWeek: 0, opensAt: '09:00', closesAt: '15:00' },
  ];
  it('returns the local day window, not the UTC day window', () => {
    expect(todayWindow(rows, new Date('2026-11-07T05:30:00Z'), TZ)).toEqual(
      rows[0],
    );
    expect(todayWindow(rows, new Date('2026-11-08T05:00:00Z'), TZ)).toEqual(
      rows[1],
    );
  });
  it('returns null when the local day has no window', () => {
    // Monday.
    expect(todayWindow(rows, new Date('2026-11-09T05:00:00Z'), TZ)).toBeNull();
  });
});
