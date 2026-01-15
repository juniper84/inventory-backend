import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  buildPaginatedResponse,
  parsePagination,
  PaginationQuery,
} from '../common/pagination';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(
    businessId: string,
    query: PaginationQuery & {
      search?: string;
      scope?: string;
      permissionCount?: string;
    },
  ) {
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
