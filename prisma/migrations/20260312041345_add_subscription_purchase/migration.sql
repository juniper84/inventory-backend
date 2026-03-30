/*
  Warnings:

  - You are about to drop the `SupportChatManualEmbedding` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PlatformIncidentEvent" DROP CONSTRAINT "PlatformIncidentEvent_incidentId_fkey";

-- DropIndex
DROP INDEX "ExportJob_status_type_createdAt_idx";

-- AlterTable
ALTER TABLE "PlatformAdminRefreshToken" ALTER COLUMN "id" DROP DEFAULT;

-- DropTable
DROP TABLE "SupportChatManualEmbedding";

-- CreateTable
CREATE TABLE "SubscriptionPurchase" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "isPaid" BOOLEAN NOT NULL DEFAULT true,
    "amountDue" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPurchase_idempotencyKey_key" ON "SubscriptionPurchase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SubscriptionPurchase_businessId_createdAt_idx" ON "SubscriptionPurchase"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPurchase_platformAdminId_createdAt_idx" ON "SubscriptionPurchase"("platformAdminId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPurchase_isPaid_createdAt_idx" ON "SubscriptionPurchase"("isPaid", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionPurchase" ADD CONSTRAINT "SubscriptionPurchase_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPurchase" ADD CONSTRAINT "SubscriptionPurchase_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformIncidentEvent" ADD CONSTRAINT "PlatformIncidentEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "PlatformIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
