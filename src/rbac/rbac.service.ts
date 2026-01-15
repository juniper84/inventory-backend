import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

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
