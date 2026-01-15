import { Module } from '@nestjs/common';
import { OfflineController } from './offline.controller';
import { OfflineService } from './offline.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { SettingsModule } from '../settings/settings.module';
import { SalesModule } from '../sales/sales.module';
import { StockModule } from '../stock/stock.module';
import { PurchasesModule } from '../purchases/purchases.module';

@Module({
  imports: [
    SubscriptionModule,
    AuditModule,
    RbacModule,
    SettingsModule,
    SalesModule,
    StockModule,
    PurchasesModule,
  ],
  controllers: [OfflineController],
  providers: [OfflineService],
})
export class OfflineModule {}
