import { RbacService } from './rbac.service';

describe('RbacService', () => {
  it('filters roles by businessId', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      userRole: { findMany },
    } as any;

    const service = new RbacService(prisma);
    await service.resolveUserAccess('user-1', 'business-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', role: { businessId: 'business-1' } },
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
  });
});
