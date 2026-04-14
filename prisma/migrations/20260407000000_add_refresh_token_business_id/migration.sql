-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "businessId" TEXT;

-- CreateIndex
CREATE INDEX "RefreshToken_businessId_idx" ON "RefreshToken"("businessId");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
