import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';
import { PermissionsList } from '../rbac/permissions';
import { ForbiddenException } from '@nestjs/common';

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
    const forbiddenCodes = [
      PermissionsList.BUSINESS_DELETE,
      PermissionsList.ROLES_CREATE,
      PermissionsList.ROLES_UPDATE,
    ];
    const forbiddenPermissions = await this.prisma.permission.findMany({
      where: { code: { in: forbiddenCodes } },
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
      ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
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

  async create(businessId: string, data: { name: string; isSystem?: boolean }) {
    const result = await this.prisma.role.create({
      data: {
        businessId,
        name: data.name,
        isSystem: data.isSystem ?? false,
      },
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'ROLE_CREATE',
      resourceType: 'Role',
      resourceId: result.id,
      outcome: 'SUCCESS',
      reason: 'Role created',
      metadata: data,
    });
    return result;
  }

  async update(businessId: string, roleId: string, data: { name?: string }) {
    const before = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!before) {
      return null;
    }
    const result = await this.prisma.role.update({
      where: { id: roleId },
      data,
    });
    this.auditService.logEvent({
      businessId,
      userId: 'system',
      action: 'ROLE_UPDATE',
      resourceType: 'Role',
      resourceId: roleId,
      outcome: 'SUCCESS',
      reason: 'Role updated',
      metadata: data,
      before: before as unknown as Record<string, unknown>,
      after: result as unknown as Record<string, unknown>,
    });
    return result;
  }

  async setRolePermissions(
    businessId: string,
    roleId: string,
    permissionIds: string[],
  ) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, businessId },
    });
    if (!role) {
      return null;
    }
    if (role.name === 'System Owner') {
      throw new ForbiddenException('System Owner permissions are locked.');
    }

    if (role.name === 'Admin') {
      const forbiddenCodes = [
        PermissionsList.BUSINESS_DELETE,
        PermissionsList.ROLES_CREATE,
        PermissionsList.ROLES_UPDATE,
      ];
      const forbiddenPermissions = await this.prisma.permission.findMany({
        where: { code: { in: forbiddenCodes } },
        select: { id: true },
      });
      const forbiddenIds = new Set(
        forbiddenPermissions.map((perm) => perm.id),
      );
      permissionIds = permissionIds.filter((id) => !forbiddenIds.has(id));
    }

    await this.prisma.rolePermission.deleteMany({ where: { roleId } });
    if (permissionIds.length > 0) {
      await this.prisma.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId,
          permissionId,
        })),
        skipDuplicates: true,
      });
    }

    await this.auditService.logEvent({
      businessId,
      userId: 'system',
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
