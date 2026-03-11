-- Add ON DELETE CASCADE to auth/identity token tables
-- These records are meaningless without their parent User, so cascade is safe.

ALTER TABLE "RefreshToken"
  DROP CONSTRAINT IF EXISTS "RefreshToken_userId_fkey",
  ADD CONSTRAINT "RefreshToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordResetToken"
  DROP CONSTRAINT IF EXISTS "PasswordResetToken_userId_fkey",
  ADD CONSTRAINT "PasswordResetToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmailVerificationToken"
  DROP CONSTRAINT IF EXISTS "EmailVerificationToken_userId_fkey",
  ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ON DELETE CASCADE to BusinessUser (membership records belong to both User and Business)
ALTER TABLE "BusinessUser"
  DROP CONSTRAINT IF EXISTS "BusinessUser_userId_fkey",
  ADD CONSTRAINT "BusinessUser_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BusinessUser"
  DROP CONSTRAINT IF EXISTS "BusinessUser_businessId_fkey",
  ADD CONSTRAINT "BusinessUser_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ON DELETE CASCADE to BusinessSettings (settings belong entirely to a Business)
ALTER TABLE "BusinessSettings"
  DROP CONSTRAINT IF EXISTS "BusinessSettings_businessId_fkey",
  ADD CONSTRAINT "BusinessSettings_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add ON DELETE CASCADE to Subscription (a subscription belongs entirely to a Business)
ALTER TABLE "Subscription"
  DROP CONSTRAINT IF EXISTS "Subscription_businessId_fkey",
  ADD CONSTRAINT "Subscription_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
