import { Module, forwardRef } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UnitsModule } from '../units/units.module';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [forwardRef(() => ApprovalsModule), NotificationsModule, UnitsModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
