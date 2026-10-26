// Loads what the delivery-acceptance act needs for a list of orders: the order, its lines, the customer, the rep and the balance on file.
// Shared by the printable blank (POST /api/orders/blank-pdf) and the electronically signed act (signedActs.js), so both show the same paper.
import { pool } from "./db/pool.js";
import { OFFICE_PHONE } from "./pricelistPdf.js";

export async function loadBlankOrders(ids, db = pool) {
  const { rows: orders } = await db.query(
    `SELECT o.id, o.order_code, o.created_at, o.total_amd, o.user_id, o.customer_id, o.payment_term_days, o.downpayment_amd, o.downpayment_pct,
            c.name AS customer_name, c.erp_customer_id, c.address AS customer_address, c.phone AS customer_phone, c.tin AS customer_tin, c.legal_name AS customer_legal_name, u.name AS rep_name, u.name_hy AS rep_name_hy, u.phone AS rep_phone, erp.debt_amd
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN users u ON u.id = o.user_id
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE o.id = ANY($1)`,
    [ids]
  );
  const { rows: itemRows } = await db.query(
    `SELECT oi.order_id, oi.brand, oi.product_name, p.unit AS size_l, oi.quantity, oi.unit_price_amd, oi.line_total_amd
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ANY($1) ORDER BY oi.id`,
    [ids]
  );
  const byId = new Map(orders.map((o) => [o.id, o]));
  // The data object buildOrderBlanksPdf draws; `extra` adds fields such as the signatures.
  const blank = (id, variant, extra = {}) => {
    const o = byId.get(id);
    return {
      variant,
      order: { order_code: o.order_code, created_at: o.created_at, total_amd: o.total_amd },
      terms: { dueDays: o.payment_term_days, downpaymentAmd: o.downpayment_amd, downpaymentPct: o.downpayment_pct },
      items: itemRows.filter((r) => r.order_id === id).map((r) => ({ ...r, quantity: Number(r.quantity), unit_price_amd: Number(r.unit_price_amd), line_total_amd: Number(r.line_total_amd) })),
      customer: { name: o.customer_name, erp_customer_id: o.erp_customer_id, tin: o.customer_tin, legal_name: o.customer_legal_name, address: o.customer_address, phone: o.customer_phone },
      rep: { name: o.rep_name_hy || o.rep_name, phone: o.rep_phone, officePhone: OFFICE_PHONE },
      // The customer's balance on file (Excel) before this order; blank line when unknown.
      previousDebtAmd: o.debt_amd != null ? Number(o.debt_amd) : null,
      paymentAmd: null,
      ...extra,
    };
  };
  return { orders, byId, blank };
}
