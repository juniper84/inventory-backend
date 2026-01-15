import { TransfersService } from './transfers.service';

describe('TransfersService', () => {
  it('scopes approvals to business records', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'transfer-1' });
    const prisma = { transfer: { findFirst } } as any;
    const auditService = { logEvent: jest.fn() } as any;
    const approvalsService = {
      requestApproval: jest.fn().mockResolvedValue({
        required: true,
        approval: { id: 'approval-1' },
      }),
    } as any;
    const notificationsService = { create: jest.fn() } as any;

    const service = new TransfersService(
      prisma,
      auditService,
      approvalsService,
      notificationsService,
    );

    await service.approve('business-1', 'transfer-1', 'user-1', []);

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'transfer-1', businessId: 'business-1' },
    });
  });
});
