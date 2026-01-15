import { StockService } from './stock.service';

describe('StockService', () => {
  it('scopes adjustments to business records', async () => {
    const branchFindFirst = jest.fn().mockResolvedValue({ id: 'branch-1' });
    const variantFindFirst = jest.fn().mockResolvedValue({ id: 'variant-1' });
    const prisma = {
      branch: { findFirst: branchFindFirst },
      variant: { findFirst: variantFindFirst },
    } as any;
    const auditService = { logEvent: jest.fn() } as any;
    const approvalsService = {
      requestApproval: jest.fn().mockResolvedValue({
        required: true,
        approval: { id: 'approval-1' },
      }),
    } as any;
    const notificationsService = { create: jest.fn() } as any;

    const service = new StockService(
      prisma,
      auditService,
      approvalsService,
      notificationsService,
    );

    await service.createAdjustment('business-1', 'user-1', [], {
      branchId: 'branch-1',
      variantId: 'variant-1',
      quantity: 1,
      type: 'POSITIVE',
    });

    expect(branchFindFirst).toHaveBeenCalledWith({
      where: { id: 'branch-1', businessId: 'business-1' },
    });
    expect(variantFindFirst).toHaveBeenCalledWith({
      where: { id: 'variant-1', businessId: 'business-1' },
      include: { product: { select: { name: true } } },
    });
  });
});
