-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- Add locale settings to business settings
ALTER TABLE "BusinessSettings" ADD COLUMN "localeSettings" JSONB;
UPDATE "BusinessSettings"
SET "localeSettings" = '{"currency":"TZS","timezone":"Africa/Dar_es_Salaam","dateFormat":"DD/MM/YYYY"}'
WHERE "localeSettings" IS NULL;
ALTER TABLE "BusinessSettings" ALTER COLUMN "localeSettings" SET NOT NULL;

-- Add targeting fields to notifications
ALTER TABLE "Notification" ADD COLUMN "roleId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "branchId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "permission" TEXT;

-- CreateIndex
CREATE INDEX "IdempotencyKey_businessId_scope_createdAt_idx" ON "IdempotencyKey"("businessId", "scope", "createdAt");
CREATE UNIQUE INDEX "IdempotencyKey_businessId_scope_key_key" ON "IdempotencyKey"("businessId", "scope", "key");
CREATE INDEX "Notification_businessId_roleId_idx" ON "Notification"("businessId", "roleId");
CREATE INDEX "Notification_businessId_branchId_idx" ON "Notification"("businessId", "branchId");
CREATE INDEX "Notification_businessId_permission_idx" ON "Notification"("businessId", "permission");

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
