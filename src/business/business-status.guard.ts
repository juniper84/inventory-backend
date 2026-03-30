import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { AuditService } from '../audit/audit.service';
import { buildRequestMetadata } from '../audit/audit.utils';

@Injectable()
export class BusinessStatusGuard implements CanActivate {
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
    const user = request.user;
    // Platform/support tokens have no businessId — allow them through first.
    if (user?.scope === 'platform' || user?.scope === 'support') {
      return true;
    }
    if (!user?.businessId) {
      // Authenticated business user with no businessId claim — deny rather than fail open.
      throw new ForbiddenException('Business context required.');
    }

    const business = await this.prisma.business.findUnique({
      where: { id: user.businessId },
      select: { id: true, status: true },
    });
    if (!business) {
      throw new ForbiddenException('Business not found.');
    }

    if (['ARCHIVED', 'DELETED', 'SUSPENDED'].includes(business.status)) {
      await this.auditService.logEvent({
        businessId: user.businessId,
        userId: user.sub,
        action: 'BUSINESS_STATUS_BLOCK',
        resourceType: 'Business',
        resourceId: user.businessId,
        outcome: 'FAILURE',
        reason: business.status,
        metadata: buildRequestMetadata(request),
      });
      if (business.status === 'SUSPENDED') {
        throw new HttpException(
          {
            message: 'Business is not active.',
            errorCode: 'BUSINESS_SUSPENDED',
            statusCode: 403,
          },
          HttpStatus.FORBIDDEN,
        );
      }
      throw new ForbiddenException('Business is not active.');
    }

    return true;
  }
}
