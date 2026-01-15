-- DropForeignKey
ALTER TABLE "SaleRefund" DROP CONSTRAINT "SaleRefund_saleId_fkey";

-- AddForeignKey
ALTER TABLE "SaleRefund" ADD CONSTRAINT "SaleRefund_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
