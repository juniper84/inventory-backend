import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { buildRequestMetadata } from '../audit/audit.utils';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAFE_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/password-reset/request',
  '/api/v1/auth/password-reset/confirm',
  '/api/v1/auth/email-verification/request',
  '/api/v1/auth/email-verification/confirm',
  '/api/v1/health',
]);

@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const method = (request.method || '').toUpperCase();
    if (SAFE_METHODS.has(method)) {
      return true;
    }

    const path = request.originalUrl?.split('?')[0] ?? request.url ?? '';
    if (SAFE_PATHS.has(path)) {
      return true;
    }

    const user = request.user;
    if (user?.scope === 'platform') {
      return true;
    }
    if (user?.scope === 'support') {
      await this.auditService.logEvent({
        businessId: user.businessId ?? 'unknown',
        userId: user.sub,
        action: 'SUPPORT_WRITE_BLOCK',
        resourceType: 'SupportAccess',
        outcome: 'FAILURE',
        reason: 'Support view is read-only',
        metadata: {
          resourceName: 'Support access (read-only)',
          method,
          path,
          ...buildRequestMetadata(request),
        },
      });
      throw new ForbiddenException('Support access is read-only.');
    }
    if (!user?.businessId) {
      return true;
    }

    const settings = await this.prisma.businessSettings.findUnique({
      where: { businessId: user.businessId },
      select: { readOnlyEnabled: true, readOnlyReason: true },
    });

    if (!settings?.readOnlyEnabled) {
      return true;
    }

    await this.auditService.logEvent({
      businessId: user.businessId,
      userId: user.sub,
      action: 'READ_ONLY_BLOCK',
      resourceType: 'BusinessSettings',
      outcome: 'FAILURE',
      reason: settings.readOnlyReason ?? 'Read-only mode enabled',
      metadata: {
        method,
        path,
        ...buildRequestMetadata(request),
      },
    });

    throw new ForbiddenException('Business is in read-only mode.');
  }
}
