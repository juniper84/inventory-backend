-- CreateEnum
CREATE TYPE "InventoryValuationMethod" AS ENUM ('FIFO', 'LIFO', 'AVERAGE');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "unitCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "expectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ReceivingLine" ADD COLUMN     "batchId" TEXT;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "unitCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "StockSnapshot" ADD COLUMN     "inTransitQuantity" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "leadTimeDays" INTEGER;

-- CreateTable
CREATE TABLE "ReorderPoint" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "minQuantity" DECIMAL(12,2) NOT NULL,
    "reorderQuantity" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReorderPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReorderPoint_businessId_branchId_idx" ON "ReorderPoint"("businessId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "ReorderPoint_businessId_branchId_variantId_key" ON "ReorderPoint"("businessId", "branchId", "variantId");

-- AddForeignKey
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReorderPoint" ADD CONSTRAINT "ReorderPoint_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingLine" ADD CONSTRAINT "ReceivingLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
