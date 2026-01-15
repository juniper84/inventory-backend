import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  async createRequest(params: {
    businessId: string;
    userId: string;
    permission: string;
    path: string;
    reason?: string | null;
  }) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: params.userId,
        memberships: { some: { businessId: params.businessId } },
      },
      select: { id: true, name: true, email: true },
    });
    const requester = user?.name || user?.email || user?.id || 'Unknown user';
    const reason = params.reason?.trim();
    const messageLines = [
      `${requester} requested access to ${params.permission}.`,
      params.path ? `Path: ${params.path}` : null,
      reason ? `Reason: ${reason}` : null,
    ].filter(Boolean);
    const message = messageLines.join('\n');

    const notifications = await this.notificationsService.notifyEvent({
      businessId: params.businessId,
      eventKey: 'accessRequest',
      title: 'Access request',
      message,
      priority: 'ACTION_REQUIRED',
      metadata: {
        requestedPermission: params.permission,
        requestedPath: params.path,
        requestedBy: params.userId,
        reason: reason ?? null,
      },
    });
    const notificationId = notifications[0]?.id ?? null;

    await this.auditService.logEvent({
      businessId: params.businessId,
      userId: params.userId,
      action: 'ACCESS_REQUEST',
      resourceType: 'Notification',
      resourceId: notificationId ?? 'n/a',
      outcome: 'SUCCESS',
      reason: reason ?? undefined,
      metadata: {
        permission: params.permission,
        path: params.path,
      },
    });

    return { id: notificationId };
  }
}
