CREATE OR REPLACE FUNCTION prevent_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Deletes are not allowed on %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Updates are not allowed on %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS stock_movement_no_delete ON "StockMovement";
CREATE TRIGGER stock_movement_no_delete
BEFORE DELETE ON "StockMovement"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS stock_movement_no_update ON "StockMovement";
CREATE TRIGGER stock_movement_no_update
BEFORE UPDATE ON "StockMovement"
FOR EACH ROW
EXECUTE FUNCTION prevent_update();

DROP TRIGGER IF EXISTS sale_no_delete ON "Sale";
CREATE TRIGGER sale_no_delete
BEFORE DELETE ON "Sale"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS sale_line_no_delete ON "SaleLine";
CREATE TRIGGER sale_line_no_delete
BEFORE DELETE ON "SaleLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS sale_payment_no_delete ON "SalePayment";
CREATE TRIGGER sale_payment_no_delete
BEFORE DELETE ON "SalePayment"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS sale_refund_no_delete ON "SaleRefund";
CREATE TRIGGER sale_refund_no_delete
BEFORE DELETE ON "SaleRefund"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS sale_refund_line_no_delete ON "SaleRefundLine";
CREATE TRIGGER sale_refund_line_no_delete
BEFORE DELETE ON "SaleRefundLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS sale_settlement_no_delete ON "SaleSettlement";
CREATE TRIGGER sale_settlement_no_delete
BEFORE DELETE ON "SaleSettlement"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS purchase_no_delete ON "Purchase";
CREATE TRIGGER purchase_no_delete
BEFORE DELETE ON "Purchase"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS purchase_line_no_delete ON "PurchaseLine";
CREATE TRIGGER purchase_line_no_delete
BEFORE DELETE ON "PurchaseLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS purchase_order_no_delete ON "PurchaseOrder";
CREATE TRIGGER purchase_order_no_delete
BEFORE DELETE ON "PurchaseOrder"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS purchase_order_line_no_delete ON "PurchaseOrderLine";
CREATE TRIGGER purchase_order_line_no_delete
BEFORE DELETE ON "PurchaseOrderLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS receiving_line_no_delete ON "ReceivingLine";
CREATE TRIGGER receiving_line_no_delete
BEFORE DELETE ON "ReceivingLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS purchase_payment_no_delete ON "PurchasePayment";
CREATE TRIGGER purchase_payment_no_delete
BEFORE DELETE ON "PurchasePayment"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS supplier_return_no_delete ON "SupplierReturn";
CREATE TRIGGER supplier_return_no_delete
BEFORE DELETE ON "SupplierReturn"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();

DROP TRIGGER IF EXISTS supplier_return_line_no_delete ON "SupplierReturnLine";
CREATE TRIGGER supplier_return_line_no_delete
BEFORE DELETE ON "SupplierReturnLine"
FOR EACH ROW
EXECUTE FUNCTION prevent_delete();
