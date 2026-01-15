-- Add size tracking for attachments
ALTER TABLE "Attachment" ADD COLUMN "sizeMb" DECIMAL(12, 2);
