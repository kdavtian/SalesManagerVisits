import sharp from "sharp";
import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-23: ticking "Products delivered" on a check-in offers the customer's CONFIRMED and PACKED orders; on submit they become Delivered.
test.use({ geolocation: { latitude: 40.18, longitude: 44.51, accuracy: 10 }, permissions: ["geolocation"] });

test("check-in: Products delivered lists confirmed + packed orders and moves the ticked ones to Delivered", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  const product = await fixtures.createProduct({ unit: "4L" });
  const confirmed = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "confirmed", total_amd: 12000, product, quantity: 3, order_code: "E2E-DLV-1" });
  const packed = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "packed_stock_out", total_amd: 8000, product, quantity: 2, order_code: "E2E-DLV-2" });
  const submitted = await fixtures.createOrder({ customer_id: customer.id, user_id: rep.id, status: "submitted", total_amd: 5000, product, quantity: 1, order_code: "E2E-DLV-3" });

  await loginViaUi(page, rep.email);
  await page.goto(`/#/checkin/${customer.id}`);
  await expect(page.locator("#checkin-submit")).toBeEnabled({ timeout: 15000 });

  await expect(page.locator("#delivered-orders-field")).toBeHidden();
  await page.locator('label.outcome-chip:has(input[value="customer_unavailable"])').click();
  await expect(page.locator("#delivered-orders-field")).toBeVisible();
  const rows = page.locator(".delivered-order-row");
  await expect(rows).toHaveCount(2); // the submitted order is not offered
  await expect(rows.nth(0)).toContainText("E2E-DLV-1");
  await expect(rows.nth(1)).toContainText("E2E-DLV-2");

  // nothing sticks out of the screen on a phone
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await rows.nth(0).click(); // tick only the confirmed one

  // The signed order blank must be photographed (owner, 2026-10-26): submitting without it is refused on the spot.
  await page.locator("#checkin-submit").click();
  await expect(page.locator("#blank-photo-error")).toBeVisible();
  const blank = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 240, g: 240, b: 240 } } }).jpeg().toBuffer();
  await page.locator("#blank-photo-input").setInputFiles({ name: "blank.jpg", mimeType: "image/jpeg", buffer: blank });
  await expect(page.locator("#blank-thumb-grid .photo-thumb")).toHaveCount(1);
  await expect(page.locator("#blank-photo-error")).toBeHidden();

  const [response] = await Promise.all([page.waitForResponse((res) => res.url().endsWith("/api/checkins") && res.request().method() === "POST"), page.locator("#checkin-submit").click()]);
  expect(response.ok()).toBeTruthy();
  const created = await response.json();
  fixtures.trackRow("checkins", created.id);
  expect(created.delivered_orders.map((o) => o.id)).toEqual([confirmed.id]);
  expect(created.order_blank_count).toBe(1);
  const { rows: blankRows } = await pool.query("SELECT kind, order_ids FROM checkin_photos WHERE checkin_id = $1", [created.id]);
  expect(blankRows).toEqual([{ kind: "order_blank", order_ids: [confirmed.id] }]);
  await expect(page.locator(".delivered-orders-done")).toBeVisible();

  const { rows: after } = await pool.query("SELECT id, status FROM orders WHERE id = ANY($1)", [[confirmed.id, packed.id, submitted.id]]);
  const byId = Object.fromEntries(after.map((r) => [r.id, r.status]));
  expect(byId[confirmed.id]).toBe("delivered");
  expect(byId[packed.id]).toBe("packed_stock_out");
  expect(byId[submitted.id]).toBe("submitted");
});
