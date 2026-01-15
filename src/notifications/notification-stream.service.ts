import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Notification } from '@prisma/client';
import { Observable, Subject, interval, merge } from 'rxjs';
import { filter, map, startWith } from 'rxjs/operators';
import { JwtPayload } from '../auth/auth.types';
import { PermissionsList } from '../rbac/permissions';

type StreamContext = {
  businessId: string;
  userId: string;
  roleIds: string[];
  branchScope: string[];
  permissions: string[];
  scope?: JwtPayload['scope'];
};

type StreamEvent = {
  data: unknown;
  event?: string;
  id?: string;
  retry?: number;
};

@Injectable()
export class NotificationStreamService {
  private readonly notificationSubject = new Subject<Notification>();
  private readonly announcementSubject = new Subject<unknown>();

  constructor(private readonly jwtService: JwtService) {}

  emit(notification: Notification) {
    this.notificationSubject.next(notification);
  }

  emitAnnouncementChanged(payload: unknown = { changed: true }) {
    this.announcementSubject.next(payload);
  }

  createStream(token: string): Observable<StreamEvent> {
    if (!token) {
      throw new UnauthorizedException('Missing access token.');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid access token.');
    }

    if (!payload?.businessId || !payload?.sub) {
      throw new UnauthorizedException('Invalid access token.');
    }

    if (
      payload.scope !== 'platform' &&
      !payload.permissions?.includes(PermissionsList.NOTIFICATIONS_READ)
    ) {
      throw new ForbiddenException('Missing notifications permission.');
    }

    const context: StreamContext = {
      businessId: payload.businessId,
      userId: payload.sub,
      roleIds: payload.roleIds ?? [],
      branchScope: payload.branchScope ?? [],
      permissions: payload.permissions ?? [],
      scope: payload.scope,
    };

    const notifications = this.notificationSubject.asObservable().pipe(
      filter((notification) => this.matches(notification, context)),
      map((notification) => ({
        event: 'notification',
        data: notification,
      })),
    );

    const keepAlive = interval(25000).pipe(
      map(() => ({
        event: 'ping',
        data: { ts: Date.now() },
      })),
    );

    const announcements = this.announcementSubject.asObservable().pipe(
      map((payload) => ({
        event: 'announcement',
        data: payload ?? { changed: true },
      })),
    );

    return merge(notifications, announcements, keepAlive).pipe(
      startWith({
        event: 'ready',
        data: { ok: true },
      }),
    );
  }

  private matches(notification: Notification, context: StreamContext) {
    if (notification.businessId !== context.businessId) {
      return false;
    }
    if (notification.userId) {
      return notification.userId === context.userId;
    }
    if (notification.roleId) {
      return context.roleIds.includes(notification.roleId);
    }
    if (notification.branchId) {
      return context.branchScope.includes(notification.branchId);
    }
    if (notification.permission) {
      return context.permissions.includes(notification.permission);
    }
    return true;
  }
}
