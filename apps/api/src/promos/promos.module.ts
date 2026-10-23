import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromoCode } from './promo-code.entity';
import { PromosService } from './promos.service';
import { PromosController } from './promos.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PromoCode])],
  providers: [PromosService],
  controllers: [PromosController],
  exports: [PromosService],
})
export class PromosModule {}
