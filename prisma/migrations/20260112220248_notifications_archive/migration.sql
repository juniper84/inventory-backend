-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_businessId_archivedAt_idx" ON "Notification"("businessId", "archivedAt");
