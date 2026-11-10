import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RestockRepairDto } from './restock-repair.dto';

/**
 * DTO-level guards for the admin restock-repair overrides — same contract
 * family as CancelStaleDto: an all-optional body must validate, a
 * present-but-bad value must not. Runs without booting Nest/DB.
 */
const check = (data: Record<string, unknown>) =>
  validateSync(plainToInstance(RestockRepairDto, data), {
    whitelist: true,
    forbidUnknownValues: true,
  });

describe('RestockRepairDto', () => {
  it('accepts an empty body (no overrides)', () => {
    expect(check({})).toEqual([]);
  });

  it('accepts valid overrides', () => {
    expect(check({ graceMinutes: 2, limit: 50 })).toEqual([]);
  });

  it('coerces a numeric string to a number', () => {
    const inst = plainToInstance(RestockRepairDto, { graceMinutes: '1' });
    expect(inst.graceMinutes).toBe(1);
    expect(check({ graceMinutes: '1' })).toEqual([]);
  });

  it('rejects zero / negative graceMinutes', () => {
    expect(check({ graceMinutes: 0 }).length).toBeGreaterThan(0);
    expect(check({ graceMinutes: -1 }).length).toBeGreaterThan(0);
  });

  it('rejects graceMinutes above the 7-day ceiling', () => {
    expect(check({ graceMinutes: 10081 }).length).toBeGreaterThan(0);
    expect(check({ graceMinutes: 10080 })).toEqual([]); // boundary ok
  });

  it('rejects limit above the batch ceiling', () => {
    expect(check({ limit: 501 }).length).toBeGreaterThan(0);
    expect(check({ limit: 500 })).toEqual([]); // boundary ok
  });

  it('rejects a non-numeric override', () => {
    expect(check({ graceMinutes: 'abc' }).length).toBeGreaterThan(0);
    expect(check({ limit: 1.5 }).length).toBeGreaterThan(0);
  });

  it('dryRun is not a DTO field (script-only knob): it validates as a stripped unknown, never reaches the service', () => {
    // class-transformer copies the unknown key onto the instance, but the
    // global ValidationPipe (whitelist: true) strips undecorated properties —
    // the controller reads only dto.graceMinutes/dto.limit, so a body-level
    // dryRun can only ever be silently ignored (see the admin HTTP spec).
    expect(check({ dryRun: true })).toEqual([]);
    expect(new RestockRepairDto()).not.toHaveProperty('dryRun');
  });
});
