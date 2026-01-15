-- Phase C POS/Sales enhancements

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

ALTER TABLE "BusinessSettings"
ADD COLUMN "posPolicies" JSONB;

UPDATE "BusinessSettings"
SET "posPolicies" = '{
  "receiptTemplate": "THERMAL",
  "discountThresholdPercent": 10,
  "discountThresholdAmount": 50000,
  "refundReturnToStockDefault": true,
  "offlineLimits": {
    "maxDurationHours": 48,
    "maxSalesCount": 200,
    "maxTotalValue": 5000000
  }
}'::jsonb
WHERE "posPolicies" IS NULL;

ALTER TABLE "BusinessSettings"
ALTER COLUMN "posPolicies" SET NOT NULL;

ALTER TABLE "Variant"
ADD COLUMN "minPrice" DECIMAL(12,2);

ALTER TABLE "Sale"
ADD COLUMN "isOffline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "offlineDeviceId" TEXT,
ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cartDiscount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN "completionKey" TEXT;

CREATE UNIQUE INDEX "Sale_businessId_completionKey_key"
ON "Sale"("businessId", "completionKey");

ALTER TABLE "SaleLine"
ADD COLUMN "batchId" TEXT,
ADD COLUMN "productName" TEXT,
ADD COLUMN "variantName" TEXT,
ADD COLUMN "skuSnapshot" TEXT,
ADD COLUMN "barcodeSnapshot" TEXT;

UPDATE "SaleLine"
SET "productName" = COALESCE(p."name", ''),
    "variantName" = COALESCE(v."name", '')
FROM "Variant" v
JOIN "Product" p ON v."productId" = p."id"
WHERE "SaleLine"."variantId" = v."id";

UPDATE "SaleLine"
SET "productName" = COALESCE("productName", ''),
    "variantName" = COALESCE("variantName", '')
WHERE "productName" IS NULL OR "variantName" IS NULL;

ALTER TABLE "SaleLine"
ALTER COLUMN "productName" SET NOT NULL,
ALTER COLUMN "variantName" SET NOT NULL;

ALTER TABLE "SaleLine"
ADD CONSTRAINT "SaleLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SalePayment"
ADD COLUMN "methodLabel" TEXT;

CREATE TABLE "SaleRefund" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashierId" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "returnToStock" BOOLEAN NOT NULL DEFAULT true,
    "total" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleRefund_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleRefundLine" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "batchId" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "SaleRefundLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "SaleRefund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleRefundLine" ADD CONSTRAINT "SaleRefundLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
