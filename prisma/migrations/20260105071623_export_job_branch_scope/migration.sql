-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "ExportJob_businessId_branchId_idx" ON "ExportJob"("businessId", "branchId");
