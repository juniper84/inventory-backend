-- CreateTable
CREATE TABLE "PlatformScheduledAction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformScheduledAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformScheduledAction_businessId_cancelledAt_executedAt_idx" ON "PlatformScheduledAction"("businessId", "cancelledAt", "executedAt");

-- CreateIndex
CREATE INDEX "PlatformScheduledAction_scheduledFor_executedAt_cancelledAt_idx" ON "PlatformScheduledAction"("scheduledFor", "executedAt", "cancelledAt");

-- AddForeignKey
ALTER TABLE "PlatformScheduledAction" ADD CONSTRAINT "PlatformScheduledAction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformScheduledAction" ADD CONSTRAINT "PlatformScheduledAction_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
