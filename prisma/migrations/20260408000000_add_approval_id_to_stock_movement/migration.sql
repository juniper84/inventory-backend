-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN "approvalId" TEXT;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "StockMovement_approvalId_idx" ON "StockMovement"("approvalId");
