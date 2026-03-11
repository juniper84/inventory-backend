-- Add unique constraint to prevent duplicate supplier names within a business
CREATE UNIQUE INDEX "Supplier_businessId_name_key"
  ON "Supplier"("businessId", "name");

-- Add userId index to PasswordResetToken for faster lookups by user
CREATE INDEX "PasswordResetToken_userId_idx"
  ON "PasswordResetToken"("userId");

-- Add userId index to AuditLog for user-scoped audit queries
CREATE INDEX "AuditLog_userId_idx"
  ON "AuditLog"("userId");
