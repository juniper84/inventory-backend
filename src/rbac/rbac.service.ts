import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  // NOTE: P4-SW1-H10 — resolveUserAccess is called on every authenticated request
  // (token refresh, permission checks, offline sync). It executes a multi-join DB
  // query each time with no caching. For high-traffic businesses this will become a
  // bottleneck. Future improvement: add a short-lived in-memory or Redis cache keyed
  // by (userId, businessId) with TTL ~60s, invalidated on role/permission changes.
  async resolveUserAccess(userId: string, businessId: string) {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, role: { businessId } },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    const roleIds = roles.map((role) => role.roleId);
    const permissions = new Set<string>();
    const branchScope = new Set<string>();

    roles.forEach((role) => {
      if (role.branchId) {
        branchScope.add(role.branchId);
      }
      role.role.rolePermissions.forEach((rp) =>
        permissions.add(rp.permission.code),
      );
    });

    return {
      roleIds,
      permissions: Array.from(permissions),
      branchScope: Array.from(branchScope),
      businessId,
    };
  }
}
