import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Payments redesign, release 3b (owner, 2026-11-02: "keep both, upgrade +"): the Payments "+" sheet of a rep warns once when the customer
// gave no proof (no pop-up), takes the customer's signature on the phone, and saves without signal -- the payment is sent with its
// signature (and the signed slip PDF is made) as soon as the phone is online again.
const SHOTS = process.env.BD_SHOTS;
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
async function draw(page) {
  const c = page.locator(".sig-pad-canvas");
  const b = await c.boundingBox();
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i < 30; i++) await page.mouse.move(b.x + 20 + i * 8, b.y + b.height / 2 + Math.sin(i) * 25);
  await page.mouse.up();
}
test("@smoke @iphone Payments +: no-proof warning, customer signature, saved without signal and sent when online", async ({ page, fixtures, context }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const c = await fixtures.createCustomer({ created_by: rep.id, name: `Proof Shop ${Date.now()}` });
  try {
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    await loginViaUi(page, rep.email);
    await page.goto("/#/payments");
    await page.locator("#payments-new-btn").click({ timeout: 15000 });
    await page.locator("#payment-pick-customer").click();
    await page.locator("#payment-customer-search").fill(c.name);
    await page.locator(`[data-customer-id="${c.id}"]`).click({ timeout: 10000 });
    await page.locator("#payment-amount-input").fill("23000");
    await shot(page, "pay-plus");
    await page.locator("#payment-add-submit").click();
    await expect(page.locator("#payment-add-warn")).toBeVisible();
    await shot(page, "pay-warn");
    // sign: own signature first, then the customer's
    await page.locator("#pay-sign-btn").click();
    await draw(page); await page.locator('.sig-pad [data-act="done"], [data-act="done"]').last().click();
    await page.waitForTimeout(400);
    if (await page.locator(".sig-pad-canvas").count()) { await draw(page); await page.locator('[data-act="done"]').last().click(); }
    await expect(page.locator("#pay-sign-chip")).toBeVisible({ timeout: 10000 });
    await shot(page, "pay-signed");
    // no signal: saved on the phone
    await context.setOffline(true);
    await page.locator("#payment-add-submit").click();
    await expect(page.locator("#payment-add-submit")).toHaveCount(0, { timeout: 10000 });
    expect((await pool.query("SELECT count(*)::int AS n FROM payments WHERE customer_id = $1", [c.id])).rows[0].n).toBe(0);
    await shot(page, "pay-offline");
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await pool.query("SELECT customer_confirmation FROM payments WHERE customer_id = $1", [c.id])).rows[0]?.customer_confirmation, { timeout: 20000 }).toBe("signed");
    await expect.poll(async () => (await pool.query("SELECT mime FROM customer_files WHERE customer_id = $1", [c.id])).rows.map((r) => r.mime), { timeout: 20000 }).toContain("application/pdf");
  } finally {
    await pool.query("DELETE FROM customer_files WHERE customer_id = $1", [c.id]);
    await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE customer_id = $1)", [c.id]);
    await pool.query("DELETE FROM payments WHERE customer_id = $1", [c.id]);
  }
});
