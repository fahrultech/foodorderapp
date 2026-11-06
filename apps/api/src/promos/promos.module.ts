import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { PromoCode } from './promo-code.entity';
import { PromoUsage } from './promo-usage.entity';
import { PromosService } from './promos.service';
import { PromosController } from './promos.controller';
import { PromosAdminController } from './promos-admin.controller';

@Module({
  // AuthModule (-> JwtModule) because the guards on these controllers need
  // JwtService in THIS module's context. No cycle: AuthModule imports nothing.
  imports: [TypeOrmModule.forFeature([PromoCode, PromoUsage]), AuthModule],
  providers: [PromosService],
  controllers: [PromosController, PromosAdminController],
  exports: [PromosService],
})
export class PromosModule {}
