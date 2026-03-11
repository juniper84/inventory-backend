import { randomUUID } from 'crypto';
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
export class NotificationStreamService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationStreamService.name);
  private readonly notificationSubject = new Subject<Notification>();
  private readonly announcementSubject = new Subject<unknown>();
  private readonly forceLogoutSubject = new Subject<{
    userIds: string[];
    reason?: string;
  }>();
  private readonly channel = 'nvi:notifications';
  private lastRedisErrorLogAt = 0;
  private redisPublisher?: RedisClientType;
  private redisSubscriber?: RedisClientType;
  private readonly streamTokens = new Map<string, { context: StreamContext; expiresAt: number }>();

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
        this.logRedisError('publisher', error);
      });
      this.redisSubscriber.on('error', (error) => {
        this.logRedisError('subscriber', error);
      });
      await this.redisPublisher.connect();
      await this.redisSubscriber.connect();
      await this.redisSubscriber.subscribe(this.channel, (message) => {
        try {
          const payload = JSON.parse(message) as {
            type: 'notification' | 'announcement' | 'force-logout';
            data: unknown;
          };
          if (payload.type === 'notification') {
            this.notificationSubject.next(payload.data as Notification);
          } else if (payload.type === 'announcement') {
            this.announcementSubject.next(payload.data);
          } else if (payload.type === 'force-logout') {
            this.forceLogoutSubject.next(
              payload.data as { userIds: string[]; reason?: string },
            );
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

  emitForceLogout(userIds: string[], reason?: string) {
    if (!userIds.length) {
      return;
    }
    if (this.redisPublisher) {
      void this.redisPublisher.publish(
        this.channel,
        JSON.stringify({ type: 'force-logout', data: { userIds, reason } }),
      );
      return;
    }
    this.forceLogoutSubject.next({ userIds, reason });
  }

  async generateStreamToken(payload: JwtPayload): Promise<string> {
    const uuid = randomUUID();
    const context: StreamContext = {
      businessId: payload.businessId,
      userId: payload.sub,
      roleIds: payload.roleIds ?? [],
      branchScope: payload.branchScope ?? [],
      permissions: payload.permissions ?? [],
      scope: payload.scope,
    };
    if (this.redisPublisher) {
      await this.redisPublisher.set(
        `nvi:st:${uuid}`,
        JSON.stringify(context),
        { EX: 900 },
      );
    } else {
      this.streamTokens.set(uuid, { context, expiresAt: Date.now() + 900_000 });
    }
    return uuid;
  }

  private async resolveStreamToken(uuid: string): Promise<StreamContext | null> {
    if (this.redisPublisher) {
      const raw = await this.redisPublisher.get(`nvi:st:${uuid}`);
      if (!raw) return null;
      await this.redisPublisher.del(`nvi:st:${uuid}`);
      try {
        return JSON.parse(raw) as StreamContext;
      } catch {
        return null;
      }
    }
    const entry = this.streamTokens.get(uuid);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.streamTokens.delete(uuid);
      return null;
    }
    this.streamTokens.delete(uuid);
    return entry.context;
  }

  async createStream(token: string): Promise<Observable<StreamEvent>> {
    if (!token) {
      throw new UnauthorizedException('Missing access token.');
    }

    let context: StreamContext;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (uuidRegex.test(token)) {
      const resolved = await this.resolveStreamToken(token);
      if (!resolved) {
        throw new UnauthorizedException('Invalid or expired stream token.');
      }
      context = resolved;
    } else {
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
      context = {
        businessId: payload.businessId,
        userId: payload.sub,
        roleIds: payload.roleIds ?? [],
        branchScope: payload.branchScope ?? [],
        permissions: payload.permissions ?? [],
        scope: payload.scope,
      };
    }

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

    // Emit a force-logout event only to the affected user. The frontend
    // handles this by clearing the session and redirecting to login.
    const forceLogout = this.forceLogoutSubject.asObservable().pipe(
      filter((payload) => payload.userIds.includes(context.userId)),
      map((payload) => ({
        type: 'force-logout',
        data: { reason: payload.reason },
      })),
    );

    return merge(notifications, announcements, forceLogout, keepAlive).pipe(
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

  private logRedisError(channel: 'publisher' | 'subscriber', error: unknown) {
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt < 30000) {
      return;
    }
    this.lastRedisErrorLogAt = now;
    this.logger.warn(
      `Redis ${channel} error: ${
        error instanceof Error ? error.message : String(error)
      } (throttled)`,
    );
  }
}
