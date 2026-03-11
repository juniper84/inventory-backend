import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import {
  ADMIN_FORBIDDEN_PERMISSIONS,
  PermissionsList,
} from '../rbac/permissions';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private async enforceAdminPermissionRules(businessId: string) {
    const adminRole = await this.prisma.role.findFirst({
      where: { businessId, name: 'Admin' },
      select: { id: true },
    });
    if (!adminRole) {
      return;
    }
    const forbiddenPermissions = await this.prisma.permission.findMany({
      where: { code: { in: ADMIN_FORBIDDEN_PERMISSIONS } },
      select: { id: true },
    });
    const forbiddenIds = forbiddenPermissions.map((perm) => perm.id);
    if (!forbiddenIds.length) {
      return;
    }
    await this.prisma.rolePermission.deleteMany({
      where: { roleId: adminRole.id, permissionId: { in: forbiddenIds } },
    });
  }

  async list(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      scope?: string;
      permissionCount?: string;
    },
  ) {
    await this.enforceAdminPermissionRules(businessId);
    const pagination = parsePagination(query);
    const search = query.search?.trim();
    const scope = query.scope?.toLowerCase();
    const permissionCount = query.permissionCount?.toLowerCase();
    const where: Prisma.RoleWhereInput = {
      businessId,
      ...(search
        ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } }
        : {}),
      ...(scope === 'system'
        ? { isSystem: true }
        : scope === 'custom'
          ? { isSystem: false }
          : {}),
      ...(permissionCount === 'none'
        ? { rolePermissions: { none: {} } }
        : permissionCount === 'some'
          ? { rolePermissions: { some: {} } }
          : {}),
    };
    const items = await this.prisma.role.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...pagination,
    });
    return buildPaginatedResponse(items, pagination.take);
  }

  listPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  async getRolePermissions(businessId: string, roleId: string) {
    await this.enforceAdminPermissionRules(businessId);
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
      include: { rolePermissions: true },
    });
    if (!role) {
      return null;
    }
    return role.rolePermissions.map((rp) => rp.permissionId);
  }

  async create(
    businessId: string,
    userId: string,
    data: { name: string; approvalTier?: number },
  ) {
    const tier = Math.min(Math.max(Math.floor(data.approvalTier ?? 0), 0), 2);
    const result = await this.prisma.role.create({
      data: {
        businessId,
        name: data.name,
        isSystem: false,
        approvalTier: tier,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'ROLE_CREATE',
      resourceType: 'Role',
      resourceId: result.id,
      outcome: 'SUCCESS',
      reason: 'Role created',
      metadata: data,
    });
    return result;
  }

  async update(
    businessId: string,
    roleId: string,
    userId: string,
    data: { name?: string; approvalTier?: number },
  ) {
    // Wrap ownership check + update in $transaction to prevent TOCTOU race (Fix P4-A-H8)
    const txResult = await this.prisma.$transaction(async (tx) => {
      const before = await tx.role.findFirst({
        where: { id: roleId, businessId },
      });
      if (!before) {
        return null;
      }
      if (before.isSystem) {
        throw new ForbiddenException('System roles cannot be renamed.');
      }
      const updateData: { name?: string; approvalTier?: number } = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.approvalTier !== undefined) {
        updateData.approvalTier = Math.min(
          Math.max(Math.floor(data.approvalTier), 0),
          2,
        );
      }
      const updated = await tx.role.update({
        where: { id: roleId },
        data: updateData,
      });
      return { before, updated };
    });
    if (!txResult) {
      return null;
    }
    this.auditService.logEvent({
      businessId,
      userId,
      action: 'ROLE_UPDATE',
      resourceType: 'Role',
      resourceId: roleId,
      outcome: 'SUCCESS',
      reason: 'Role updated',
      metadata: data,
      before: txResult.before as unknown as Record<string, unknown>,
      after: txResult.updated as unknown as Record<string, unknown>,
    });
    return txResult.updated;
  }

  async setRolePermissions(
    businessId: string,
    roleId: string,
    userId: string,
    permissionIds: string[],
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!role) {
      return null;
    }
    if (role.isSystem && role.name === 'System Owner') {
      throw new ForbiddenException('System Owner permissions are locked.');
    }

    if (role.name === 'Admin') {
      const forbiddenPermissions = await this.prisma.permission.findMany({
        where: { code: { in: ADMIN_FORBIDDEN_PERMISSIONS } },
        select: { id: true },
      });
      const forbiddenIds = new Set(forbiddenPermissions.map((perm) => perm.id));
      permissionIds = permissionIds.filter((id) => !forbiddenIds.has(id));
    }

    if (permissionIds.length > 0) {
      const validPermissions = await this.prisma.permission.findMany({
        where: { id: { in: permissionIds } },
        select: { id: true },
      });
      const validIds = new Set(validPermissions.map((p) => p.id));
      const invalid = permissionIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new BadRequestException('Invalid permission IDs.');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({
            roleId,
            permissionId,
          })),
          skipDuplicates: true,
        });
      }
    });

    await this.auditService.logEvent({
      businessId,
      userId,
      action: 'ROLE_PERMISSIONS_UPDATE',
      resourceType: 'Role',
      resourceId: roleId,
      outcome: 'SUCCESS',
      reason: 'Role permissions updated',
      metadata: { permissionIds },
    });

    return { roleId, permissionIds };
  }
}
