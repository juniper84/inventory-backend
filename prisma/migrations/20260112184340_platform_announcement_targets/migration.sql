-- CreateEnum
CREATE TYPE "PlatformAnnouncementSegmentType" AS ENUM ('TIER', 'STATUS');

-- CreateTable
CREATE TABLE "PlatformAnnouncementBusinessTarget" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,

    CONSTRAINT "PlatformAnnouncementBusinessTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAnnouncementSegmentTarget" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "type" "PlatformAnnouncementSegmentType" NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "PlatformAnnouncementSegmentTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformAnnouncementBusinessTarget_businessId_idx" ON "PlatformAnnouncementBusinessTarget"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAnnouncementBusinessTarget_announcementId_businessI_key" ON "PlatformAnnouncementBusinessTarget"("announcementId", "businessId");

-- CreateIndex
CREATE INDEX "PlatformAnnouncementSegmentTarget_type_value_idx" ON "PlatformAnnouncementSegmentTarget"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAnnouncementSegmentTarget_announcementId_type_value_key" ON "PlatformAnnouncementSegmentTarget"("announcementId", "type", "value");

-- AddForeignKey
ALTER TABLE "PlatformAnnouncementBusinessTarget" ADD CONSTRAINT "PlatformAnnouncementBusinessTarget_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "PlatformAnnouncement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAnnouncementBusinessTarget" ADD CONSTRAINT "PlatformAnnouncementBusinessTarget_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAnnouncementSegmentTarget" ADD CONSTRAINT "PlatformAnnouncementSegmentTarget_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "PlatformAnnouncement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
