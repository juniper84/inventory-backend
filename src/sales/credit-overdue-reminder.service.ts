import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CreditOverdueReminderService
  implements OnModuleInit, OnModuleDestroy
{
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit() {
    this.runSweep().catch(() => undefined);
    this.intervalId = setInterval(() => {
      this.runSweep().catch(() => undefined);
    }, REMINDER_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private async runSweep() {
    const now = new Date();
    const overdueSales = await this.prisma.sale.findMany({
      where: {
        status: SaleStatus.COMPLETED,
        outstandingAmount: { gt: new Prisma.Decimal(0) },
        creditDueDate: { not: null, lte: now },
      },
      select: {
        id: true,
        businessId: true,
        customerNameSnapshot: true,
        outstandingAmount: true,
        creditDueDate: true,
      },
    });

    for (const sale of overdueSales) {
      const notify = await this.notificationsService.isEventEnabled(
        sale.businessId,
        'creditOverdue',
      );
      if (!notify) {
        continue;
      }

      const existing = await this.prisma.notification.findFirst({
        where: {
          businessId: sale.businessId,
          AND: [
            { metadata: { path: ['event'], equals: 'CREDIT_OVERDUE' } },
            { metadata: { path: ['saleId'], equals: sale.id } },
          ],
        },
      });
      if (existing) {
        continue;
      }

      await this.notificationsService.notifyEvent({
        businessId: sale.businessId,
        eventKey: 'creditOverdue',
        title: 'Credit overdue',
        message: sale.customerNameSnapshot
          ? `Credit overdue for ${sale.customerNameSnapshot}.`
          : `Credit overdue for sale ${sale.id}.`,
        priority: 'WARNING',
        metadata: {
          event: 'CREDIT_OVERDUE',
          saleId: sale.id,
          outstandingAmount: sale.outstandingAmount.toString(),
          creditDueDate: sale.creditDueDate?.toISOString() ?? null,
        },
      });

      await this.auditService.logEvent({
        businessId: sale.businessId,
        userId: 'system',
        action: 'CREDIT_OVERDUE_REMINDER',
        resourceType: 'Sale',
        resourceId: sale.id,
        outcome: 'SUCCESS',
        metadata: {
          outstandingAmount: sale.outstandingAmount.toString(),
          creditDueDate: sale.creditDueDate?.toISOString() ?? null,
          customerName: sale.customerNameSnapshot ?? null,
        },
      });
    }
  }
}
