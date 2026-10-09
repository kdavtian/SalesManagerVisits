// POST /api/orders/blank-pdf: print-ready order blanks. Small orders share an
// A4 sheet two by two, a big one gets its own sheet; a rep can only print
// their own orders.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const pageCount = (pdfText) => (pdfText.match(/\/Type \/Page\b/g) ?? []).length;

async function orderWithLines(customer, user, n, code) {
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, user_id, status, payment_method, total_amd, order_code) VALUES ($1, $2, 'confirmed', 'cash', $3, $4) RETURNING id",
    [customer.id, user.id, n * 2000, code]
  );
  const id = trackOrder(rows[0].id);
  for (let i = 0; i < n; i++) {
    const p = await createProduct({ unit_price_amd: 1000 });
    await pool.query(
      "INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, 'Castrol', 1000, 2, 2000)",
      [id, p.id, `Oil ${i}`]
    );
  }
  return id;
}

test("blank PDF: two small orders share one sheet, a big one takes its own; reps only print their own", async () => {
  const rep = await createUser("sales_manager");
  const other = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: rep.id, erp_customer_id: `itest-bl-${Date.now()}` });
  const stamp = String(Date.now()).slice(-6);
  const small1 = await orderWithLines(customer, rep, 3, `S${stamp}1`);
  const small2 = await orderWithLines(customer, rep, 5, `S${stamp}2`);
  const big = await orderWithLines(customer, rep, 12, `S${stamp}3`);
  const otherOrder = await orderWithLines(customer, other, 2, `S${stamp}4`);
  const cookie = await loginAs(rep.email);

  const two = await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie, body: { order_ids: [small1, small2] } });
  assert.equal(two.status, 200);
  assert.ok(String(two.data).startsWith("%PDF"));
  assert.equal(pageCount(two.data), 1);

  const three = await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie, body: { order_ids: [small1, small2, big] } });
  assert.equal(pageCount(three.data), 2); // half sheet with two orders + one full sheet

  const forcedFull = await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie, body: { order_ids: [small1, small2], variant: "full" } });
  assert.equal(pageCount(forcedFull.data), 2);

  assert.equal((await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie, body: { order_ids: [otherOrder] } })).status, 403);
  assert.equal((await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie, body: { order_ids: [] } })).status, 400);

  // Management can print anyone's.
  const dirCookie = await loginAs(director.email);
  assert.equal((await apiRequest("/api/orders/blank-pdf", { method: "POST", cookie: dirCookie, body: { order_ids: [otherOrder] } })).status, 200);
});
