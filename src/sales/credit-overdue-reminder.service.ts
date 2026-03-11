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

    // Pre-fetch all already-notified sale IDs in one query to reduce per-row
    // check-then-write races. The narrow window between this batch read and the
    // individual writes below is an accepted residual risk given the low
    // frequency of the sweep (once per 24 h) and the idempotent notification content.
    const businessIds = [...new Set(overdueSales.map((s) => s.businessId))];
    const existingNotifications = await this.prisma.notification.findMany({
      where: {
        businessId: { in: businessIds },
        metadata: { path: ['event'], equals: 'CREDIT_OVERDUE' },
      },
      select: { metadata: true },
    });
    const alreadyNotifiedSaleIds = new Set(
      existingNotifications
        .map((n) => (n.metadata as Record<string, unknown> | null)?.['saleId'])
        .filter((id): id is string => typeof id === 'string'),
    );

    for (const sale of overdueSales) {
      if (alreadyNotifiedSaleIds.has(sale.id)) {
        continue;
      }

      const notify = await this.notificationsService.isEventEnabled(
        sale.businessId,
        'creditOverdue',
      );
      if (!notify) {
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
        userId: 'cron', // scheduled background job — no human actor
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
