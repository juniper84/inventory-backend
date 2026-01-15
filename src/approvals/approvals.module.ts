import { Module, forwardRef } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [forwardRef(() => StockModule), NotificationsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
