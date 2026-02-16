-- AlterEnum
ALTER TYPE "ExportJobStatus" ADD VALUE 'CANCELED';

-- CreateIndex
CREATE INDEX "ExportJob_status_type_createdAt_idx" ON "ExportJob"("status", "type", "createdAt");
