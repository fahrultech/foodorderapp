import { Repository } from 'typeorm';
import { FeatureFlag } from './feature-flag.entity';
import { FeatureFlagsService, featureFlagBucket } from './feature-flags.service';

function flag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    key: 'new-checkout',
    description: null,
    enabled: true,
    rolloutPercentage: 100,
    createdAt: new Date('2026-11-04T00:00:00.000Z'),
    updatedAt: new Date('2026-11-04T00:00:00.000Z'),
    ...overrides,
  };
}

describe('featureFlagBucket', () => {
  it('assigns a stable 0-99 bucket from the flag key and subject', () => {
    expect(featureFlagBucket('new-checkout', 'customer-a')).toBe(95);
    expect(featureFlagBucket('new-checkout', 'customer-b')).toBe(5);
    expect(featureFlagBucket('new-checkout', 'customer-c')).toBe(47);
    expect(featureFlagBucket('new-checkout', 'customer-a')).toBe(95);
  });

  it('keeps different flags in independent cohorts', () => {
    expect(featureFlagBucket('new-checkout', 'customer-a')).not.toBe(
      featureFlagBucket('compact-menu', 'customer-a'),
    );
  });
});

describe('FeatureFlagsService', () => {
  let repo: Pick<Repository<FeatureFlag>, 'findOne'>;
  let service: FeatureFlagsService;

  beforeEach(() => {
    repo = { findOne: jest.fn() };
    service = new FeatureFlagsService(repo as Repository<FeatureFlag>);
  });

  it('fails closed when the flag does not exist', async () => {
    jest.mocked(repo.findOne).mockResolvedValue(null);

    await expect(service.isEnabled('missing-flag', 'customer-a')).resolves.toBe(false);
    expect(repo.findOne).toHaveBeenCalledWith({ where: { key: 'missing-flag' } });
  });

  it('returns false when the flag is globally disabled', async () => {
    jest.mocked(repo.findOne).mockResolvedValue(flag({ enabled: false }));

    await expect(service.isEnabled('new-checkout', 'customer-b')).resolves.toBe(false);
  });

  it('supports global on and off rollout boundaries without a subject', async () => {
    jest.mocked(repo.findOne)
      .mockResolvedValueOnce(flag({ rolloutPercentage: 100 }))
      .mockResolvedValueOnce(flag({ rolloutPercentage: 0 }));

    await expect(service.isEnabled('new-checkout')).resolves.toBe(true);
    await expect(service.isEnabled('new-checkout')).resolves.toBe(false);
  });

  it('fails closed for a partial rollout without a stable subject', async () => {
    jest.mocked(repo.findOne).mockResolvedValue(flag({ rolloutPercentage: 50 }));

    await expect(service.isEnabled('new-checkout')).resolves.toBe(false);
  });

  it('enables only subjects whose stable bucket is below the rollout percentage', async () => {
    jest.mocked(repo.findOne).mockResolvedValue(flag({ rolloutPercentage: 20 }));

    await expect(service.isEnabled('new-checkout', 'customer-b')).resolves.toBe(true);
    await expect(service.isEnabled('new-checkout', 'customer-c')).resolves.toBe(false);
    await expect(service.isEnabled('new-checkout', 'customer-a')).resolves.toBe(false);
  });
});
