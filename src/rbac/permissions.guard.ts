import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { AuditService } from '../audit/audit.service';
import { buildRequestMetadata } from '../audit/audit.utils';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const userPermissions: string[] = request.user?.permissions || [];

    if (request.user?.scope === 'platform') {
      return true;
    }

    const allowed = requiredPermissions.every((perm) =>
      userPermissions.includes(perm),
    );

    const branchScope: string[] = request.user?.branchScope || [];
    if (allowed && branchScope.length > 0) {
      const candidateIds = new Set<string>();
      const body = request.body ?? {};
      const params = request.params ?? {};
      const query = request.query ?? {};

      const addValue = (value: unknown) => {
        if (typeof value === 'string' && value.trim().length > 0) {
          candidateIds.add(value);
        }
      };

      addValue(body.branchId);
      addValue(body.sourceBranchId);
      addValue(body.destinationBranchId);
      addValue(params.branchId);
      addValue(query.branchId);

      if (candidateIds.size > 0) {
        const inScope = Array.from(candidateIds).every((id) =>
          branchScope.includes(id),
        );
        if (!inScope) {
          await this.auditService.logEvent({
            businessId: request.user?.businessId,
            userId: request.user?.sub,
            action: 'BRANCH_SCOPE_CHECK',
            resourceType: 'Branch',
            outcome: 'FAILURE',
            metadata: {
              requiredBranchIds: Array.from(candidateIds),
              branchScope,
              ...buildRequestMetadata(request),
            },
          });
          throw new ForbiddenException('Branch-scoped role restriction.');
        }
      }
    }

    if (request.user?.businessId) {
      await this.auditService.logEvent({
        businessId: request.user?.businessId,
        userId: request.user?.sub,
        action: 'PERMISSION_CHECK',
        resourceType: 'Permission',
        outcome: allowed ? 'SUCCESS' : 'FAILURE',
        metadata: {
          requiredPermissions,
          ...buildRequestMetadata(request),
        },
      });
    }

    return allowed;
  }
}
