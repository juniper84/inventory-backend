-- Add storage key for durable attachment exports
ALTER TABLE "Attachment" ADD COLUMN "storageKey" TEXT;
