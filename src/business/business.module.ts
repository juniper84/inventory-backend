import { Module } from '@nestjs/common';
import { SubscriptionModule } from '../subscription/subscription.module';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

@Module({
  imports: [SubscriptionModule],
  controllers: [BusinessController],
  providers: [BusinessService],
  exports: [BusinessService],
})
export class BusinessModule {}
