import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-26: electronic signature of the delivery-acceptance act. The rep draws their own signature once (kept on the profile), the
// customer signs once on the rep's phone for every delivered order, one signed PDF per order is made and the orders lock.
test.use({ geolocation: { latitude: 40.18, longitude: 44.51, accuracy: 10 }, permissions: ["geolocation"] });

async function scribble(page) {
  // The pad slides in (and the second one opens only after the first one is saved): draw on the one that is open and settled.
  const canvas = page.locator(".sig-pad-canvas");
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(350);
  const box = await page.locator(".sig-pad-canvas").boundingBox();
  await page.mouse.move(box.x + 30, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(box.x + 30 + i * 8, box.y + box.height * (0.6 - 0.25 * Math.sin(i / 3)), { steps: 2 });
  await page.mouse.up();
}

test("check-in: the customer signs once for every ticked order; one signed PDF each, the orders lock", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const product = await fixtures.createProduct({ unit: "4L" });
  const a = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 12000, product, quantity: 3, order_code: "E2E-SIG-1" });
  const b = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 8000, product, quantity: 2, order_code: "E2E-SIG-2" });

  await loginViaUi(page, rep.email);
  await page.goto(`/#/checkin/${customer.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });
  await page.locator('label.outcome-chip:has(input[value="customer_unavailable"])').click();
  await expect(page.locator(".delivered-order-row")).toHaveCount(2);

  // the signature belongs to the ticked orders: nothing ticked -> told to tick first
  for (const box of await page.locator("#delivered-orders-list input:checked").all()) await box.uncheck();
  await page.locator("#blank-sign-btn").click();
  await expect(page.locator("#blank-photo-error")).toBeVisible();

  await page.locator(".delivered-order-row").nth(0).click();
  await page.locator(".delivered-order-row").nth(1).click();
  await page.locator("#blank-sign-btn").click();

  // first time: the rep's own signature (kept on their profile)
  await expect(page.locator(".sig-pad-head h2")).toHaveText("Your signature");
  await page.locator('.sig-pad [data-act="done"]').click(); // empty -> refused
  await expect(page.locator("#sig-pad-error")).toBeVisible();
  await scribble(page);
  await page.locator('.sig-pad [data-act="done"]').click();

  // then the customer's
  await expect(page.locator(".sig-pad-head h2")).toHaveText("Customer signature");
  await scribble(page);
  await page.locator('.sig-pad [data-act="done"]').click();
  await expect(page.locator("#blank-sign-chip")).toBeVisible();
  await expect(page.locator(".sig-pad")).toHaveCount(0);

  const [response] = await Promise.all([page.waitForResponse((res) => res.url().endsWith("/api/checkins") && res.request().method() === "POST"), page.locator("#checkin-submit").click()]);
  expect(response.status()).toBe(201);
  const created = await response.json();
  fixtures.trackRow("checkins", created.id);
  expect(created.signed_acts).toHaveLength(2);

  // one signed PDF per order; View opens it in the viewer as a picture, with Share and Save (owner, 2026-10-27)
  await expect(page.locator("[data-view-doc]")).toHaveCount(2);
  await page.locator("[data-view-doc]").first().click();
  await expect(page.locator(".file-viewer .file-viewer-page")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.file-viewer [data-act="share"]')).toBeVisible();
  await expect(page.locator('.file-viewer [data-act="save-image"]')).toBeVisible();
  await page.locator(".file-viewer-close").click();
  const { rows: files } = await pool.query("SELECT kind, mime, order_ids FROM customer_files WHERE checkin_id = $1 ORDER BY id", [created.id]);
  expect(files.map((f) => [f.kind, f.mime])).toEqual([["signed_act", "application/pdf"], ["signed_act", "application/pdf"]]);
  const { rows: orders } = await pool.query("SELECT status, signed_at FROM orders WHERE id = ANY($1)", [[a.id, b.id]]);
  expect(orders.every((o) => o.status === "delivered" && o.signed_at)).toBe(true);
  const me = await pool.query("SELECT signature_path FROM users WHERE id = $1", [rep.id]);
  expect(me.rows[0].signature_path).toBeTruthy();

  // the order sheet says it is signed and locked
  await page.evaluate(async (id) => (await import("/js/orderDetailSheet.js")).openOrderDetailSheet(id), a.id);
  await expect(page.locator(".order-signed-note")).toContainText("Only the admin or the CEO");
  await expect(page.locator('[data-action="edit-order"]')).toHaveCount(0);
  await expect(page.locator("#order-files-slot .files-blank")).toHaveCount(1);
  await pool.query("UPDATE orders SET signature_id = NULL WHERE id = ANY($1)", [[a.id, b.id]]);
  await pool.query("DELETE FROM customer_signatures WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM customer_files WHERE checkin_id = $1", [created.id]);
});

// Owner, 2026-10-27: money collected without a delivery -> the customer signs the payment slip, which opens in the viewer with Share and Save.
test("@smoke check-in: payment collected -> the customer signs the payment slip; View shows it with Share and Save", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  await loginViaUi(page, rep.email);
  await page.goto(`/#/checkin/${customer.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });
  await page.locator('label.outcome-chip:has(input[value="payment_collected"])').click();
  await page.locator("#amount-collected-input").fill("45000");
  await expect(page.locator("#slip-sign-block")).toBeVisible();
  await page.locator("#slip-sign-btn").click();
  await scribble(page); // the rep's own signature, the first time
  await page.locator('.sig-pad [data-act="done"]').click();
  await expect(page.locator(".sig-pad-head h2")).toContainText(/Customer/); // the customer's pad is the one open now
  await scribble(page); // the customer's
  await page.locator('.sig-pad [data-act="done"]').click();
  await expect(page.locator("#slip-sign-chip")).toBeVisible();
  if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/slip-form.png`, fullPage: true });
  const [response] = await Promise.all([page.waitForResponse((res) => res.url().endsWith("/api/checkins") && res.request().method() === "POST"), page.locator("#checkin-submit").click()]);
  expect(response.status()).toBe(201);
  const created = await response.json();
  fixtures.trackRow("checkins", created.id);
  expect(created.payment_slip?.id).toBeTruthy();
  try {
    if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/slip-result.png` });
    await page.locator("[data-view-doc]").click();
    await expect(page.locator(".file-viewer .file-viewer-page")).toBeVisible({ timeout: 15000 });
    if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/slip-viewer.png` });
    await expect(page.locator(".file-viewer-title")).toContainText(/Payment slip/);
    const ids = await page.locator(".file-viewer-bar button").evaluateAll((els) => els.map((e) => e.dataset.act));
    expect(ids.slice(0, 2)).toEqual(["share", "save-image"]);
  } finally {
    await pool.query("DELETE FROM customer_files WHERE checkin_id = $1", [created.id]);
    await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE customer_id = $1)", [customer.id]);
    await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  }
});
