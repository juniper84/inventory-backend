-- CreateEnum
CREATE TYPE "SupportRequestSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SupportRequestPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "SupportAccessRequest"
ADD COLUMN "severity" "SupportRequestSeverity" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN "priority" "SupportRequestPriority" NOT NULL DEFAULT 'MEDIUM';

-- CreateIndex
CREATE INDEX "SupportAccessRequest_status_severity_priority_requestedAt_idx" ON "SupportAccessRequest"("status", "severity", "priority", "requestedAt");

-- CreateIndex
CREATE INDEX "SupportAccessRequest_platformAdminId_requestedAt_idx" ON "SupportAccessRequest"("platformAdminId", "requestedAt");

-- CreateIndex
CREATE INDEX "SupportAccessSession_platformAdminId_createdAt_idx" ON "SupportAccessSession"("platformAdminId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportAccessSession_requestId_createdAt_idx" ON "SupportAccessSession"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportAccessSession_revokedAt_expiresAt_idx" ON "SupportAccessSession"("revokedAt", "expiresAt");
