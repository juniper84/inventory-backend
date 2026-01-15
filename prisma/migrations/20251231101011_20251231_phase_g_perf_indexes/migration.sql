-- CreateIndex
CREATE INDEX "BranchVariantAvailability_businessId_idx" ON "BranchVariantAvailability"("businessId");

-- CreateIndex
CREATE INDEX "Sale_businessId_createdAt_idx" ON "Sale"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Sale_businessId_status_branchId_idx" ON "Sale"("businessId", "status", "branchId");

-- CreateIndex
CREATE INDEX "Variant_businessId_status_idx" ON "Variant"("businessId", "status");
