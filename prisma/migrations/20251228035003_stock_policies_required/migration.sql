/*
  Warnings:

  - Made the column `stockPolicies` on table `BusinessSettings` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "BusinessSettings"
ADD COLUMN IF NOT EXISTS "stockPolicies" JSONB;

UPDATE "BusinessSettings"
SET "stockPolicies" = '{
  "negativeStockAllowed": false,
  "fifoMode": "FIFO",
  "expiryPolicy": "WARN",
  "batchTrackingEnabled": false,
  "transferBatchPolicy": "PRESERVE"
}'::jsonb
WHERE "stockPolicies" IS NULL;

ALTER TABLE "BusinessSettings" ALTER COLUMN "stockPolicies" SET NOT NULL;
