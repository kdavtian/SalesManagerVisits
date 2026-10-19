// Pushes products and wholesale customers to Platform (the public KAD MOTORS
// website/PWA) after an ERP sync commits here. Platform mirrors this data
// read-only; retail customers are never part of this payload, they live
// natively on Platform's side. Best-effort: a Platform outage must never
// fail or slow down the ERP sync itself.
import { pool } from "./db/pool.js";
import { queueProductImageSync } from "./platformImageSync.js";

export async function syncProductsAndWholesaleCustomersToPlatform() {
  const url = process.env.PLATFORM_SYNC_URL;
  const key = process.env.PLATFORM_SYNC_KEY;
  if (!url || !key) return;

  const [productsResult, customersResult] = await Promise.all([
    pool.query(
      `SELECT erp_product_id, name, brand, unit, family, hc_code, active,
              stock_qty, landing_cost_amd, net_cost_amd,
              unit_price_amd AS base_price_amd, retail_price_amd,
              bronze_price_amd, silver_price_amd, gold_price_amd
       FROM products
       WHERE erp_product_id IS NOT NULL AND erp_product_id <> ''`
    ),
    pool.query(
      `SELECT c.erp_customer_id, c.name, c.customer_tier AS tier, c.sales_channel AS channel,
              ed.debt_amd, c.tin, c.legal_name, c.legal_address
       FROM customers c
       JOIN erp_customer_data ed ON ed.erp_customer_id = c.erp_customer_id
       WHERE c.erp_customer_id IS NOT NULL`
    ),
  ]);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Key": key },
    body: JSON.stringify({
      products: productsResult.rows,
      wholesale_customers: customersResult.rows,
    }),
  });

  if (!res.ok) {
    throw new Error(`Platform sync failed: ${res.status} ${await res.text()}`);
  }

  // Products now exist on Platform: send any new or changed photos.
  queueProductImageSync();
}
