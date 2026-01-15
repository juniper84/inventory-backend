import { UsersService } from './users.service';

describe('UsersService', () => {
  it('lists users scoped to business', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { businessUser: { findMany } } as any;
    const auditService = { logEvent: jest.fn() } as any;
    const subscriptionService = { assertLimit: jest.fn() } as any;
    const mailerService = { sendEmail: jest.fn() } as any;

    const service = new UsersService(
      prisma,
      auditService,
      subscriptionService,
      mailerService,
    );

    await service.list('business-1', {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: 'business-1' } }),
    );
  });
});
