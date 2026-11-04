import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FeatureFlag } from './feature-flag.entity';
import { FeatureFlagsService } from './feature-flags.service';

@Module({
  imports: [TypeOrmModule.forFeature([FeatureFlag])],
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
