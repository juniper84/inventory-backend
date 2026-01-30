import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Notification } from '@prisma/client';
import { createClient, RedisClientType } from 'redis';
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
  type?: string;
  id?: string;
  retry?: number;
};

@Injectable()
export class NotificationStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationStreamService.name);
  private readonly notificationSubject = new Subject<Notification>();
  private readonly announcementSubject = new Subject<unknown>();
  private readonly channel = 'nvi:notifications';
  private redisPublisher?: RedisClientType;
  private redisSubscriber?: RedisClientType;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      return;
    }
    try {
      this.redisPublisher = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => Math.min(retries * 250, 5000),
        },
      });
      this.redisSubscriber = this.redisPublisher.duplicate();
      this.redisPublisher.on('error', (error) => {
        this.logger.warn(`Redis publisher error: ${error?.message ?? error}`);
      });
      this.redisSubscriber.on('error', (error) => {
        this.logger.warn(`Redis subscriber error: ${error?.message ?? error}`);
      });
      await this.redisPublisher.connect();
      await this.redisSubscriber.connect();
      await this.redisSubscriber.subscribe(this.channel, (message) => {
        try {
          const payload = JSON.parse(message) as {
            type: 'notification' | 'announcement';
            data: unknown;
          };
          if (payload.type === 'notification') {
            this.notificationSubject.next(payload.data as Notification);
          } else if (payload.type === 'announcement') {
            this.announcementSubject.next(payload.data);
          }
        } catch (error) {
          this.logger.warn('Failed to parse notification payload');
        }
      });
    } catch (error) {
      this.logger.warn('Redis notifications disabled');
      this.redisSubscriber = undefined;
      this.redisPublisher = undefined;
    }
  }

  async onModuleDestroy() {
    try {
      await this.redisSubscriber?.quit();
      await this.redisPublisher?.quit();
    } catch (error) {
      this.logger.warn('Failed to close Redis connections');
    }
  }

  emit(notification: Notification) {
    if (this.redisPublisher) {
      void this.redisPublisher.publish(
        this.channel,
        JSON.stringify({ type: 'notification', data: notification }),
      );
      return;
    }
    this.notificationSubject.next(notification);
  }

  emitAnnouncementChanged(payload: unknown = { changed: true }) {
    if (this.redisPublisher) {
      void this.redisPublisher.publish(
        this.channel,
        JSON.stringify({ type: 'announcement', data: payload }),
      );
      return;
    }
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
        type: 'notification',
        data: notification,
      })),
    );

    const keepAlive = interval(25000).pipe(
      map(() => ({
        type: 'ping',
        data: { ts: Date.now() },
      })),
    );

    const announcements = this.announcementSubject.asObservable().pipe(
      map((payload) => ({
        type: 'announcement',
        data: payload ?? { changed: true },
      })),
    );

    return merge(notifications, announcements, keepAlive).pipe(
      startWith({
        type: 'ready',
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
