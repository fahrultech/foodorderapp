import { validateEnv, EnvVars } from './env.validation';

/**
 * Boot-time env validation tests.
 *
 * Each test passes a minimal record and checks that validateEnv either
 * succeeds (returns EnvVars) or throws with a message that names the
 * offending variable.
 */
describe('validateEnv', () => {
  // A baseline that satisfies all required fields
  const valid: Record<string, unknown> = {
    DATABASE_URL: 'postgresql://foodorder:pass@localhost:5432/foodorder',
    JWT_SECRET: 'super-secret-jwt-key-that-is-long-enough',
  };

  it('accepts a minimal valid config', () => {
    const result = validateEnv(valid);
    expect(result).toBeInstanceOf(EnvVars);
    expect(result.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(result.JWT_SECRET).toBe(valid.JWT_SECRET);
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = valid as Record<string, unknown>;
    expect(() => validateEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is empty string', () => {
    expect(() => validateEnv({ ...valid, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws when JWT_SECRET is missing', () => {
    const { JWT_SECRET: _omit, ...rest } = valid as Record<string, unknown>;
    expect(() => validateEnv(rest)).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is empty string', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: '' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('throws when both required fields are missing', () => {
    expect(() => validateEnv({})).toThrow(
      /Boot-time configuration validation failed/,
    );
  });

  it('accepts valid optional LOG_LEVEL values', () => {
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
      const result = validateEnv({ ...valid, LOG_LEVEL: level });
      expect(result.LOG_LEVEL).toBe(level);
    }
  });

  it('throws when LOG_LEVEL is an invalid value', () => {
    expect(() =>
      validateEnv({ ...valid, LOG_LEVEL: 'verbose' }),
    ).toThrow(/LOG_LEVEL/);
  });

  it('throws when MOCK_PAY_GATEWAY_MODE is invalid', () => {
    expect(() =>
      validateEnv({ ...valid, MOCK_PAY_GATEWAY_MODE: 'ok' }),
    ).toThrow(/MOCK_PAY_GATEWAY_MODE/);
  });

  it('accepts MOCK_PAY_GATEWAY_MODE succeed and fail', () => {
    for (const mode of ['succeed', 'fail']) {
      const result = validateEnv({ ...valid, MOCK_PAY_GATEWAY_MODE: mode });
      expect(result.MOCK_PAY_GATEWAY_MODE).toBe(mode);
    }
  });

  it('throws when MOCK_REFUND_GATEWAY_MODE is invalid', () => {
    expect(() =>
      validateEnv({ ...valid, MOCK_REFUND_GATEWAY_MODE: 'ok' }),
    ).toThrow(/MOCK_REFUND_GATEWAY_MODE/);
  });

  it('ignores unknown env vars without throwing', () => {
    const result = validateEnv({
      ...valid,
      SOME_UNKNOWN_VAR: 'whatever',
      ANOTHER_ONE: '123',
    });
    expect(result).toBeInstanceOf(EnvVars);
  });

  it('returns validated EnvVars with correct types', () => {
    const result = validateEnv({
      ...valid,
      LOG_LEVEL: 'debug',
      MOCK_PAY_GATEWAY_MODE: 'fail',
      SMTP_HOST: 'smtp.example.com',
    });
    expect(result.LOG_LEVEL).toBe('debug');
    expect(result.MOCK_PAY_GATEWAY_MODE).toBe('fail');
    expect(result.SMTP_HOST).toBe('smtp.example.com');
  });

  it('allows optional SMTP vars to be absent', () => {
    const result = validateEnv(valid);
    expect(result.SMTP_HOST).toBeUndefined();
    expect(result.SMTP_USER).toBeUndefined();
    expect(result.SMTP_PASS).toBeUndefined();
  });

  it('lists all failing constraints in one error', () => {
    try {
      validateEnv({
        DATABASE_URL: '',
        JWT_SECRET: '',
        LOG_LEVEL: 'bogus',
        MOCK_PAY_GATEWAY_MODE: 'bogus',
      });
      fail('expected to throw');
    } catch (err: unknown) {
      const msg = (err as Error).message;
      // Should mention all four violations
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/JWT_SECRET/);
      expect(msg).toMatch(/LOG_LEVEL/);
      expect(msg).toMatch(/MOCK_PAY_GATEWAY_MODE/);
    }
  });
});
