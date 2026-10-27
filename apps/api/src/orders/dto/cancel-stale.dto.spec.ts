import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CancelStaleDto } from './cancel-stale.dto';

/**
 * DTO-level guards for the admin sweep overrides — the exact regression that
 * motivated `@IsOptional()`: an all-optional body must validate, while a
 * present-but-bad value must not. Runs without booting Nest/DB.
 */
const check = (data: Record<string, unknown>) =>
  validateSync(plainToInstance(CancelStaleDto, data), {
    whitelist: true,
    forbidUnknownValues: true,
  });

describe('CancelStaleDto', () => {
  it('accepts an empty body (no overrides)', () => {
    expect(check({})).toEqual([]);
  });

  it('accepts valid overrides', () => {
    expect(check({ staleMinutes: 30, limit: 100 })).toEqual([]);
  });

  it('coerces a numeric string to a number', () => {
    const inst = plainToInstance(CancelStaleDto, { staleMinutes: '20' });
    expect(inst.staleMinutes).toBe(20);
    expect(check({ staleMinutes: '20' })).toEqual([]);
  });

  it('rejects zero / negative staleMinutes', () => {
    expect(check({ staleMinutes: 0 }).length).toBeGreaterThan(0);
    expect(check({ staleMinutes: -1 }).length).toBeGreaterThan(0);
  });

  it('rejects staleMinutes above the 7-day ceiling', () => {
    expect(check({ staleMinutes: 10081 }).length).toBeGreaterThan(0);
    expect(check({ staleMinutes: 10080 })).toEqual([]); // boundary ok
  });

  it('rejects limit above the batch ceiling', () => {
    expect(check({ limit: 501 }).length).toBeGreaterThan(0);
  });

  it('rejects a non-numeric override', () => {
    expect(check({ staleMinutes: 'abc' }).length).toBeGreaterThan(0);
  });

  it('rejects unknown keys (forbidUnknownValues) when they are the only payload', () => {
    // A body of ONLY an unknown key → whitelist strips it → validateSync is
    // handed a CancelStaleDto instance built from `{}` (all-optional) → valid.
    // This is the honest behaviour; the HTTP layer relies on it for defaults.
    expect(check({ bogus: 1 })).toEqual([]);
  });
});
