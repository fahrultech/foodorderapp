import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('feature_flags')
@Check(
  'CHK_feature_flags_rollout_percentage',
  '"rolloutPercentage" >= 0 AND "rolloutPercentage" <= 100',
)
export class FeatureFlag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 80 })
  key: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: false })
  enabled: boolean;

  @Column({ type: 'smallint', default: 100 })
  rolloutPercentage: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
