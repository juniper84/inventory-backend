-- CreateTable
CREATE TABLE "PlatformBusinessNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "platformAdminId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformBusinessNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformBusinessNote_businessId_createdAt_idx" ON "PlatformBusinessNote"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformBusinessNote_platformAdminId_idx" ON "PlatformBusinessNote"("platformAdminId");

-- AddForeignKey
ALTER TABLE "PlatformBusinessNote" ADD CONSTRAINT "PlatformBusinessNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformBusinessNote" ADD CONSTRAINT "PlatformBusinessNote_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
