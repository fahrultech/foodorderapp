import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag } from './feature-flag.entity';

/**
 * Deterministically assigns a subject to one of 100 cohorts for a flag.
 * Including the flag key keeps experiments independent for the same subject.
 */
export function featureFlagBucket(key: string, subjectId: string): number {
  const prefix = createHash('sha256')
    .update(key)
    .update('\0')
    .update(subjectId)
    .digest('hex')
    .slice(0, 8);
  return Number.parseInt(prefix, 16) % 100;
}

@Injectable()
export class FeatureFlagsService {
  constructor(
    @InjectRepository(FeatureFlag)
    private readonly repo: Repository<FeatureFlag>,
  ) {}

  /**
   * Missing and disabled flags fail closed. Partial rollouts require a stable
   * subject id; callers must not use per-request randomness for cohorting.
   */
  async isEnabled(key: string, subjectId?: string | null): Promise<boolean> {
    const flag = await this.repo.findOne({ where: { key } });
    if (!flag?.enabled || flag.rolloutPercentage <= 0) return false;
    if (flag.rolloutPercentage >= 100) return true;
    if (!subjectId) return false;
    return featureFlagBucket(key, subjectId) < flag.rolloutPercentage;
  }
}
