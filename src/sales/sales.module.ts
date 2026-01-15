import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UnitsModule } from '../units/units.module';
import { SalesController } from './sales.controller';
import { CreditOverdueReminderService } from './credit-overdue-reminder.service';
import { SalesService } from './sales.service';

@Module({
  imports: [
    ApprovalsModule,
    NotificationsModule,
    SubscriptionModule,
    UnitsModule,
  ],
  controllers: [SalesController],
  providers: [SalesService, CreditOverdueReminderService],
  exports: [SalesService],
})
export class SalesModule {}
