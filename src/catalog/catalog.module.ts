import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { StorageModule } from '../storage/storage.module';
import { UnitsModule } from '../units/units.module';

@Module({
  imports: [SubscriptionModule, ApprovalsModule, StorageModule, UnitsModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
