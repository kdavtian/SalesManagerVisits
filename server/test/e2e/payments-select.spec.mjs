import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-13 (screenshot of a cut-off Approve button): the Payments rows fit a phone, the list is grouped by day, several payments
// are approved at once (one review sheet), and a rep hands over only the payments he ticks.
test("payments: rows fit at 390 px, select two and approve them in one go", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const accountant = await fixtures.createUser("accountant");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  const made = [];
  for (const amount of [36000, 20000, 50000]) {
    made.push(await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: accountant.id, amount_amd: amount }));
  }
  await loginViaUi(page, accountant.email);
  await page.goto("/#/payments");
  const row = (p) => page.locator(`.pay-row[data-payment-id="${p.id}"]`);
  await expect(row(made[0])).toBeVisible({ timeout: 10000 });
  // the Approve button and the amount stay inside the card
  for (const p of made) {
    const card = await row(p).boundingBox();
    const btn = await row(p).locator(".payment-approve-btn").boundingBox();
    expect(btn.x + btn.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
    expect(btn.height).toBeGreaterThanOrEqual(44);
  }
  // a day heading with its count and money
  await expect(page.locator(".pay-day-heading").first()).toContainText("3");

  await page.locator("#payments-select-btn").click();
  await row(made[0]).locator(".payment-row-main").click();
  await row(made[2]).locator(".payment-row-main").click();
  await expect(page.locator("#payments-select-count")).toContainText("86,000");
  // the accountant hands cash to nobody: no Hand over button (review 2026-11-13)
  await expect(page.locator("#payments-select-handover")).toHaveCount(0);
  await page.locator("#payments-select-approve").click();
  await expect(page.locator("#payments-approve-overlay")).toBeVisible();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/payments/approve-many") && r.request().method() === "POST"),
    page.locator("#payments-approve-go").click(),
  ]);
  expect(res.ok()).toBeTruthy();
  const { rows } = await pool.query("SELECT id, status FROM payments WHERE id = ANY($1) ORDER BY id", [made.map((p) => p.id)]);
  expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [made[0].id]: "approved", [made[1].id]: "pending", [made[2].id]: "approved" });
});

test("cash handovers: the rep unticks one payment and hands over the rest; the unticked one stays with him", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  await fixtures.createUser("sales_director");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  const made = [];
  for (const amount of [15000, 7000, 3000]) {
    made.push(await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: rep.id, amount_amd: amount }));
  }
  await loginViaUi(page, rep.email);
  await page.goto("/#/cash-handoffs");
  await expect(page.locator(`[data-pick="${made[1].id}"]`)).toBeVisible({ timeout: 10000 });
  await page.locator(`[data-pick="${made[1].id}"]`).uncheck();
  await expect(page.locator("#handoff-submit-all")).toContainText("18,000");
  await page.locator("#handoff-submit-all").click();
  await expect(page.locator("#handoff-confirm-overlay")).toBeVisible();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cash-handoffs") && r.request().method() === "POST"),
    page.locator("#handoff-confirm-go").click(),
  ]);
  expect(res.ok()).toBeTruthy();
  const handoff = await res.json();
  fixtures.trackRow("cash_handoffs", handoff.id);
  const { rows } = await pool.query("SELECT id, pending_handoff_id FROM payments WHERE id = ANY($1)", [made.map((p) => p.id)]);
  const inHandoff = rows.filter((r) => r.pending_handoff_id === handoff.id).map((r) => r.id).sort();
  expect(inHandoff).toEqual([made[0].id, made[2].id].sort());
});

// Owner, 2026-11-14 (screenshot of the Payment sheet): every sheet closes with an X in its corner and by pulling it down, like KAD OS; no
// Close button in the action bar; the main action is one big button with the other actions under it.
test("payment sheet: X closes it, no Close button, Approve on top full width with Reject under it", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const rep = await fixtures.createUser("sales_manager");
  const accountant = await fixtures.createUser("accountant");
  const customer = await fixtures.createCustomer({ created_by: rep.id });
  const p = await fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, current_holder_id: accountant.id, amount_amd: 36000 });
  await loginViaUi(page, accountant.email);
  await page.goto("/#/payments");
  await page.locator(`.pay-row[data-payment-id="${p.id}"] .payment-row-main`).click();
  const actions = page.locator("#payment-detail-actions");
  await expect(actions.locator('[data-action="approve"]')).toBeVisible({ timeout: 10000 });
  await expect(actions.locator('[data-action="close"]')).toHaveCount(0);
  const bar = await actions.boundingBox();
  const approve = await actions.locator('[data-action="approve"]').boundingBox();
  const reject = await actions.locator('[data-action="reject"]').boundingBox();
  expect(approve.width).toBeGreaterThan(bar.width - 2); // the whole row
  expect(reject.y).toBeGreaterThan(approve.y + approve.height - 1); // under it
  const x = page.locator("body > .sheet-overlay .sheet-close-x");
  await expect(x).toHaveCount(1);
  await expect(page.locator("body > .sheet-overlay .sheet-grab")).toBeVisible();
  await x.click();
  await expect(page.locator("body > .sheet-overlay")).toHaveCount(0);
});
