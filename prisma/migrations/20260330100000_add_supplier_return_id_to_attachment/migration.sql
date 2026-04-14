-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN "supplierReturnId" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_supplierReturnId_idx" ON "Attachment"("supplierReturnId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_supplierReturnId_fkey" FOREIGN KEY ("supplierReturnId") REFERENCES "SupplierReturn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
