-- CreateEnum
CREATE TYPE "GainReason" AS ENUM ('UNRECORDED_PURCHASE', 'FOUND_STOCK', 'RETURN_NOT_LOGGED', 'CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "VarianceType" AS ENUM ('SHORTAGE', 'SURPLUS');

-- CreateTable
CREATE TABLE "GainEntry" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "reason" "GainReason" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GainEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountVarianceCost" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "stockMovementId" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "varianceType" "VarianceType" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockCountVarianceCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GainEntry_businessId_branchId_createdAt_idx" ON "GainEntry"("businessId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "GainEntry_businessId_variantId_createdAt_idx" ON "GainEntry"("businessId", "variantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountVarianceCost_stockMovementId_key" ON "StockCountVarianceCost"("stockMovementId");

-- CreateIndex
CREATE INDEX "StockCountVarianceCost_businessId_branchId_createdAt_idx" ON "StockCountVarianceCost"("businessId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "StockCountVarianceCost_businessId_variantId_createdAt_idx" ON "StockCountVarianceCost"("businessId", "variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "GainEntry" ADD CONSTRAINT "GainEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GainEntry" ADD CONSTRAINT "GainEntry_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GainEntry" ADD CONSTRAINT "GainEntry_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GainEntry" ADD CONSTRAINT "GainEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountVarianceCost" ADD CONSTRAINT "StockCountVarianceCost_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountVarianceCost" ADD CONSTRAINT "StockCountVarianceCost_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountVarianceCost" ADD CONSTRAINT "StockCountVarianceCost_stockMovementId_fkey" FOREIGN KEY ("stockMovementId") REFERENCES "StockMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountVarianceCost" ADD CONSTRAINT "StockCountVarianceCost_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
