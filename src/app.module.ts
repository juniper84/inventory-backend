import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { BusinessModule } from './business/business.module';
import { CatalogModule } from './catalog/catalog.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { PurchasesModule } from './purchases/purchases.module';
import { PrismaModule } from './prisma/prisma.module';
import { RbacModule } from './rbac/rbac.module';
import { RolesModule } from './roles/roles.module';
import { StockModule } from './stock/stock.module';
import { TransfersModule } from './transfers/transfers.module';
import { ExpensesModule } from './expenses/expenses.module';
import { UsersModule } from './users/users.module';
import { SalesModule } from './sales/sales.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ReportsModule } from './reports/reports.module';
import { ExportsModule } from './exports/exports.module';
import { OfflineModule } from './offline/offline.module';
import { HealthModule } from './health/health.module';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { SubscriptionModule } from './subscription/subscription.module';
import { SubscriptionGuard } from './subscription/subscription.guard';
import { PermissionsGuard } from './rbac/permissions.guard';
import { ReadOnlyGuard } from './read-only/read-only.guard';
import { PlatformModule } from './platform/platform.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';
import { SupportAccessModule } from './support-access/support-access.module';
import { MailerModule } from './mailer/mailer.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { CustomersModule } from './customers/customers.module';
import { PriceListsModule } from './price-lists/price-lists.module';
import { ShiftsModule } from './shifts/shifts.module';
import { SearchModule } from './search/search.module';
import { ImportsModule } from './imports/imports.module';
import { UnitsModule } from './units/units.module';
import { AccessRequestsModule } from './access-requests/access-requests.module';
import { NotesModule } from './notes/notes.module';
import { ApiMetricsInterceptor } from './metrics/api-metrics.interceptor';
import { AuditContextInterceptor } from './audit/audit-context.interceptor';
import { TenantThrottlerGuard } from './throttler/tenant-throttler.guard';
import { BusinessStatusGuard } from './business/business-status.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttlSeconds = Number(config.get('throttling.ttlSeconds') ?? 60);
        const limit = Number(config.get('throttling.limit') ?? 120);
        return {
          throttlers: [{ ttl: ttlSeconds, limit }],
        };
      },
    }),
    PrismaModule,
    AuthModule,
    RbacModule,
    AuditModule,
    SubscriptionModule,
    BusinessModule,
    BranchesModule,
    UsersModule,
    RolesModule,
    CatalogModule,
    PurchasesModule,
    AttachmentsModule,
    StockModule,
    TransfersModule,
    ExpensesModule,
    SalesModule,
    SuppliersModule,
    ReportsModule,
    ExportsModule,
    OfflineModule,
    HealthModule,
    PlatformModule,
    NotificationsModule,
    CustomersModule,
    PriceListsModule,
    ShiftsModule,
    SearchModule,
    ImportsModule,
    UnitsModule,
    SettingsModule,
    SupportAccessModule,
    MailerModule,
    ApprovalsModule,
    AccessRequestsModule,
    NotesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: BusinessStatusGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ReadOnlyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ApiMetricsInterceptor,
    },
  ],
})
export class AppModule {}
