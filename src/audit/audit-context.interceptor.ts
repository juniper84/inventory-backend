import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuditContextStore } from './audit-context';
import { buildRequestMetadata } from './audit.utils';

@Injectable()
export class AuditContextInterceptor implements NestInterceptor {
  constructor(private readonly auditContext: AuditContextStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const user = request?.user;
    const metadata = buildRequestMetadata(request) ?? {};
    const headerBranch =
      request?.headers?.['x-branch-id'] ?? request?.headers?.['x-branchid'];
    const rawBranchId = Array.isArray(headerBranch)
      ? headerBranch[0]
      : headerBranch;
    const branchId =
      rawBranchId ||
      request?.body?.branchId ||
      request?.query?.branchId ||
      request?.params?.branchId;
    const roleHeader =
      request?.headers?.['x-role-id'] ?? request?.headers?.['x-roleid'];
    const rawRoleId = Array.isArray(roleHeader) ? roleHeader[0] : roleHeader;
    const roleId =
      rawRoleId ||
      request?.body?.roleId ||
      (Array.isArray(user?.roleIds) && user.roleIds.length > 0
        ? user.roleIds[0]
        : undefined);
    const deviceHeader = request?.headers?.['x-device-id'];
    const deviceId = Array.isArray(deviceHeader)
      ? deviceHeader[0]
      : deviceHeader || user?.deviceId || request?.body?.deviceId;

    const ctx = {
      businessId: user?.businessId,
      userId: user?.sub,
      roleId: roleId ?? undefined,
      branchId: branchId ?? undefined,
      requestId: metadata.requestId as string | undefined,
      sessionId: metadata.sessionId as string | undefined,
      correlationId: metadata.correlationId as string | undefined,
      deviceId: deviceId ?? undefined,
      metadata,
    };

    return this.auditContext.run(ctx, () => next.handle());
  }
}
