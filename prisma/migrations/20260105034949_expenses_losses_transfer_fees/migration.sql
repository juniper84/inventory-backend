-- CreateEnum
CREATE TYPE "LossReason" AS ENUM ('DAMAGED', 'LOST', 'STOLEN', 'EXPIRED', 'SHRINKAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('GENERAL', 'TRANSFER_FEE', 'SHIPPING', 'UTILITIES', 'RENT', 'PAYROLL', 'OTHER');

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "feeAmount" DECIMAL(12,2),
ADD COLUMN     "feeCarrier" TEXT,
ADD COLUMN     "feeCurrency" TEXT,
ADD COLUMN     "feeNote" TEXT;

-- CreateTable
CREATE TABLE "LossEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "reason" "LossReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LossEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL DEFAULT 'GENERAL',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "receiptRef" TEXT,
    "transferId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LossEntry_businessId_branchId_createdAt_idx" ON "LossEntry"("businessId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "LossEntry_businessId_variantId_createdAt_idx" ON "LossEntry"("businessId", "variantId", "createdAt");

-- CreateIndex
CREATE INDEX "Expense_businessId_branchId_createdAt_idx" ON "Expense"("businessId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Expense_businessId_category_createdAt_idx" ON "Expense"("businessId", "category", "createdAt");

-- AddForeignKey
ALTER TABLE "LossEntry" ADD CONSTRAINT "LossEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LossEntry" ADD CONSTRAINT "LossEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LossEntry" ADD CONSTRAINT "LossEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LossEntry" ADD CONSTRAINT "LossEntry_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
