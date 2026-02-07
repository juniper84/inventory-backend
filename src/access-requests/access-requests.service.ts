import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly rbacService: RbacService,
  ) {}

  async createRequest(params: {
    businessId: string;
    userId: string;
    permission: string;
    path: string;
    reason?: string | null;
  }) {
    const requestedPermission = params.permission.trim();
    if (!requestedPermission) {
      throw new BadRequestException('permission is required.');
    }
    const permission = await this.prisma.permission.findUnique({
      where: { code: requestedPermission },
      select: { id: true, code: true },
    });
    if (!permission) {
      throw new BadRequestException('Unknown permission.');
    }
    const access = await this.rbacService.resolveUserAccess(
      params.userId,
      params.businessId,
    );
    if (access.permissions.includes(requestedPermission)) {
      throw new BadRequestException('User already has this permission.');
    }

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
      `${requester} requested access to ${requestedPermission}.`,
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
        requestedPermission,
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
        permission: requestedPermission,
        path: params.path,
      },
    });

    return { id: notificationId };
  }
}
