import {
  buildOrderDeliveryView,
  firstNameOf,
  OrderDeliveryInput,
} from './delivery-view';
import { ETA_DEFAULT_PREP_MINUTES } from '../restaurants/delivery-eta';

/**
 * Pure-builder specs for the tracking-page delivery polish (Phase 12,
 * session 119). The service-side wiring (who calls the builder and when)
 * lives in orders-ownership.spec.ts; this file pins the ARITHMETIC and the
 * degradation contract — durations integer minutes, never negative, never a
 * fabricated future.
 */

const NOW = new Date('2026-11-23T08:00:00.000Z');
const minutesAgo = (min: number) => new Date(NOW.getTime() - min * 60_000);

const base = (over: Partial<OrderDeliveryInput> = {}): OrderDeliveryInput => ({
  etaRow: undefined,
  avgPrepMinutes: 25,
  driverName: 'Demo Driver',
  confirmedAt: minutesAgo(10),
  createdAt: minutesAgo(30),
  ...over,
});

describe('firstNameOf', () => {
  it('takes the first whitespace-separated token', () => {
    expect(firstNameOf('Demo Driver')).toBe('Demo');
    expect(firstNameOf('  Rudi   Santoso  ')).toBe('Rudi');
    expect(firstNameOf('Budi')).toBe('Budi');
  });

  it('collapses missing/garbage to null — never an empty string', () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
    expect(firstNameOf('')).toBeNull();
    expect(firstNameOf('   ')).toBeNull();
    // A runtime value of the wrong shape must not crash the receipt.
    expect(firstNameOf(42 as unknown as string)).toBeNull();
  });
});

describe('buildOrderDeliveryView — estimate branch (curated fallback)', () => {
  it('ETA seconds minus elapsed, CEIL-ed to whole minutes', () => {
    // avgPrep 25min = 1500s; 600s elapsed -> 900s left -> ceil 15 min.
    const v = buildOrderDeliveryView(base(), NOW);
    expect(v).toEqual({
      driverFirstName: 'Demo',
      etaSource: 'estimate',
      sampleCount: 0,
      remainingMinutes: 15,
    });
  });

  it('a partial minute still counts: never rounds a remaining minute away', () => {
    // 1500s ETA, 15s elapsed -> 1485s -> ceil 25 (not 24.75, not 24).
    const v = buildOrderDeliveryView(base({ confirmedAt: minutesAgo(0.25) }), NOW);
    expect(v.remainingMinutes).toBe(25);
  });

  it('fewer than 5 samples NEVER claims observed', () => {
    const v = buildOrderDeliveryView(
      base({ etaRow: { rid: 'r1', samples: '4', median_seconds: '600' } }),
      NOW,
    );
    expect(v.etaSource).toBe('estimate');
    expect(v.sampleCount).toBe(4);
    expect(v.remainingMinutes).toBe(15); // estimate 1500s - 600s elapsed -> 900s -> 15
  });

  it('garbage avgPrepMinutes falls back to the curated 30-minute default', () => {
    const v = buildOrderDeliveryView(
      base({ avgPrepMinutes: 0, confirmedAt: minutesAgo(0) }),
      NOW,
    );
    expect(v.etaSource).toBe('estimate');
    expect(v.remainingMinutes).toBe(ETA_DEFAULT_PREP_MINUTES);
  });
});

describe('buildOrderDeliveryView — observed branch', () => {
  it('uses the real median and carries the sample count', () => {
    // 5+ samples: median 20min=1200s, 10 elapsed -> 600s -> ceil 10 min.
    const v = buildOrderDeliveryView(
      base({ etaRow: { rid: 'r1', samples: '9', median_seconds: '1200' } }),
      NOW,
    );
    expect(v).toEqual({
      driverFirstName: 'Demo',
      etaSource: 'observed',
      sampleCount: 9,
      remainingMinutes: 10,
    });
  });

  it('past-due CLAMPS at 0 — the countdown never goes negative', () => {
    const v = buildOrderDeliveryView(
      base({
        etaRow: { rid: 'r1', samples: '9', median_seconds: '300' },
        confirmedAt: minutesAgo(20),
      }),
      NOW,
    );
    expect(v.etaSource).toBe('observed');
    expect(v.remainingMinutes).toBe(0);
  });
});

describe('buildOrderDeliveryView — degradation ladder', () => {
  it('failed aggregate read (etaRow null): eta fields null, driver line survives', () => {
    const v = buildOrderDeliveryView(base({ etaRow: null }), NOW);
    expect(v).toEqual({
      driverFirstName: 'Demo',
      etaSource: null,
      sampleCount: 0,
      remainingMinutes: null,
    });
  });

  it('no confirmedAt anchors on createdAt; neither stamp -> no countdown', () => {
    const viaCreated = buildOrderDeliveryView(
      { ...base(), confirmedAt: null }, // createdAt 30min ago -> 1500-1800 -> clamp 0
      NOW,
    );
    expect(viaCreated.etaSource).toBe('estimate');
    expect(viaCreated.remainingMinutes).toBe(0);

    const anchorless = buildOrderDeliveryView(
      { ...base(), confirmedAt: null, createdAt: null },
      NOW,
    );
    expect(anchorless.etaSource).toBe('estimate');
    expect(anchorless.remainingMinutes).toBeNull();
  });

  it('garbage date strings are rejected by the anchor ladder, not crashed on', () => {
    const v = buildOrderDeliveryView(
      base({ confirmedAt: 'not-a-date', createdAt: 'also garbage' }),
      NOW,
    );
    expect(v.remainingMinutes).toBeNull();
  });

  it('missing driver name yields a null name with the ETA still derived', () => {
    const v = buildOrderDeliveryView(base({ driverName: null }), NOW);
    expect(v.driverFirstName).toBeNull();
    expect(v.etaSource).toBe('estimate');
    expect(v.remainingMinutes).toBe(15);
  });
});
