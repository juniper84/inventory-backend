-- AlterTable
ALTER TABLE "Invitation" ADD COLUMN "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Invitation" ADD COLUMN "inviteeName" TEXT;
ALTER TABLE "Invitation" ADD COLUMN "inviteePhone" TEXT;
