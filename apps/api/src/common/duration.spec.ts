import { durationToMs, expiryFrom } from './duration';

describe('durationToMs', () => {
  it('converts each supported unit', () => {
    expect(durationToMs('45s')).toBe(45_000);
    expect(durationToMs('30m')).toBe(1_800_000);
    expect(durationToMs('2h')).toBe(7_200_000);
    expect(durationToMs('30d')).toBe(2_592_000_000);
  });

  it('accepts surrounding whitespace', () => {
    expect(durationToMs(' 12h ')).toBe(43_200_000);
  });

  it('rejects formats jsonwebtoken would silently mis-read', () => {
    for (const bad of ['', '   ', 'seven days', '30', '30 minutes', '1w', '-5m', '5M', 'ms', '1.5h']) {
      expect(() => durationToMs(bad)).toThrow(/Invalid duration/);
    }
  });

  it('rejects a zero amount', () => {
    expect(() => durationToMs('0m')).toThrow(/must be positive/);
  });

  it('is safe against undefined input', () => {
    expect(() => durationToMs(undefined as any)).toThrow(/Invalid duration/);
  });
});

describe('expiryFrom', () => {
  it('adds the ttl to the supplied epoch', () => {
    const now = 1_700_000_000_000;
    expect(expiryFrom(now, '1h')).toEqual(new Date(now + 3_600_000));
  });
});
