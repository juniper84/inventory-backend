-- Add user delivery preferences and phone for SMS/WhatsApp targeting
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notificationPreferences" JSONB;
