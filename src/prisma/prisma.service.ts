import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const protectedModels = new Set([
      'AuditLog',
      'Sale',
      'SaleLine',
      'SaleRefund',
      'SaleRefundLine',
      'SaleSettlement',
      'StockMovement',
      'StockSnapshot',
      'Transfer',
      'TransferItem',
      'Purchase',
      'PurchaseOrder',
      'PurchaseOrderLine',
      'ReceivingLine',
      'PurchasePayment',
      'SupplierReturn',
      'SupplierReturnLine',
    ]);
    const deleteGuard = Prisma.defineExtension({
      name: 'deleteGuard',
      query: {
        $allModels: {
          delete({ model, args, query }) {
            if (protectedModels.has(model)) {
              throw new Error(`Deletes are disabled for ${model}.`);
            }
            return query(args);
          },
          deleteMany({ model, args, query }) {
            if (
              model === 'PurchaseOrderLine' &&
              args?.where &&
              'purchaseOrderId' in args.where
            ) {
              return query(args);
            }
            if (protectedModels.has(model)) {
              throw new Error(`Deletes are disabled for ${model}.`);
            }
            return query(args);
          },
        },
      },
    });
    super();
    return this.$extends(deleteGuard) as this;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
