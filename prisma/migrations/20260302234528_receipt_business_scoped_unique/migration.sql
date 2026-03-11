-- 1) Add as nullable first
ALTER TABLE "Receipt" ADD COLUMN "businessId" TEXT;

-- 2) Backfill from Sale
UPDATE "Receipt" r
SET "businessId" = s."businessId"
FROM "Sale" s
WHERE r."saleId" = s."id";

-- 3) Enforce required
ALTER TABLE "Receipt" ALTER COLUMN "businessId" SET NOT NULL;

-- 4) FK
ALTER TABLE "Receipt"
ADD CONSTRAINT "Receipt_businessId_fkey"
FOREIGN KEY ("businessId") REFERENCES "Business"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5) Replace global unique with business-scoped unique
DROP INDEX IF EXISTS "Receipt_receiptNumber_key";
CREATE UNIQUE INDEX "Receipt_businessId_receiptNumber_key"
ON "Receipt"("businessId", "receiptNumber");

-- 6) Support query index
CREATE INDEX "Receipt_businessId_issuedAt_idx"
ON "Receipt"("businessId", "issuedAt");
