-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "correlationId" TEXT,
ADD COLUMN     "diff" JSONB,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "previousHash" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "sessionId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_businessId_requestId_idx" ON "AuditLog"("businessId", "requestId");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_correlationId_idx" ON "AuditLog"("businessId", "correlationId");
