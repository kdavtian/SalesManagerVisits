import { test, expect, loginViaUi, newIdentityPage, pool } from "./fixtures.mjs";

// Document flow (owner, 2026-10-28): the rep taps "Hand over today's cash" on Home and confirms once; the director counts in the sheet
// (a different amount needs a note, no browser pop-ups); the confirmation makes the daily cash sheet the accountant marks "Recorded in Excel".
test("hand over from Home, count with a difference, the daily sheet for the accountant", async ({ page, browser, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const stamp = `${Date.now() % 100000}${Math.floor(Math.random() * 1000)}`;
  const rep = await fixtures.createUser("sales_manager", { name: `SheetRep${stamp}` });
  const director = await fixtures.createUser("sales_director");
  const accountant = await fixtures.createUser("accountant");
  const shop = await fixtures.createCustomer({ name: `SheetShop${stamp}`, created_by: rep.id, assigned_manager_id: rep.id });
  // the rep reports to this director in Staff, so the one-tap hand-over goes to him (other directors may exist in the test database)
  const { rows: boss } = await pool.query("INSERT INTO staff_members (name, position, user_id) VALUES ('E2E Boss', 'Sales Director', $1) RETURNING id", [director.id]);
  fixtures.trackRow("staff_members", boss[0].id);
  const { rows: me } = await pool.query("INSERT INTO staff_members (name, position, user_id, reports_to) VALUES ('E2E Rep', 'Sales Manager', $1, $2) RETURNING id", [rep.id, boss[0].id]);
  fixtures.trackRow("staff_members", me[0].id);
  for (const amount of [120000, 30000]) {
    await fixtures.createPayment({ customer_id: shop.id, customer_name_snapshot: shop.name, sales_manager_id: rep.id, amount_amd: amount, sales_channel: "SM YVN" });
  }

  // rep: Home card -> one confirm step
  await loginViaUi(page, rep.email);
  await page.goto("/#/dashboard");
  const card = page.locator("#home-handover");
  await expect(card).toContainText("150,000", { timeout: 15000 });
  await page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/handover-home.png` });
  await card.click();
  await expect(page.locator("#handoff-confirm-overlay")).toBeVisible({ timeout: 10000 });
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/cash-handoffs") && r.request().method() === "POST"),
    page.locator("#handoff-confirm-go").click(),
  ]);
  expect(created.ok()).toBeTruthy();
  const handoff = await created.json();
  fixtures.trackRow("cash_handoffs", handoff.id);

  // director: counts 140,000 -> a note is required, then it goes through
  const { context, page: desk } = await newIdentityPage(browser);
  await desk.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(desk, director.email);
  await desk.goto(`/#/cash-handoffs/${handoff.id}`);
  const counted = desk.locator("#handoff-counted");
  await expect(counted).toHaveValue("150,000", { timeout: 10000 });
  await counted.fill("140000");
  await expect(desk.locator("#handoff-diff")).toContainText("10,000");
  await expect(desk.locator("#handoff-confirm-btn")).toHaveText("Confirm with difference");
  await desk.locator("#handoff-confirm-btn").click();
  await expect(desk.locator("#handoff-detail-error")).toBeVisible();
  await desk.locator("#handoff-note").fill("10,000 short");
  await desk.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/handover-count.png` });
  await desk.locator("#handoff-confirm-btn").click();
  await expect(desk.locator("#handoff-detail-overlay")).toHaveCount(0, { timeout: 10000 });
  const { rows } = await pool.query("SELECT h.counted_amd, s.id AS sheet_id FROM cash_handoffs h JOIN cash_sheets s ON s.handoff_id = h.id WHERE h.id = $1", [handoff.id]);
  expect(Number(rows[0].counted_amd)).toBe(140000);
  await context.close();

  // accountant: the sheet with its Excel file and the "Recorded in Excel" mark
  const acc = await newIdentityPage(browser);
  await acc.page.setViewportSize({ width: 1440, height: 900 });
  await loginViaUi(acc.page, accountant.email);
  await acc.page.goto("/#/cash-handoffs");
  const sheet = acc.page.locator(`.cash-sheet-row[data-sheet="${rows[0].sheet_id}"]`);
  await expect(sheet).toContainText(`SheetRep${stamp}`, { timeout: 10000 });
  await expect(sheet).toContainText("Counted");
  await acc.page.screenshot({ path: `${process.env.GB_SHOTS ?? "/tmp"}/cash-sheets-desk.png` });
  await sheet.locator("[data-sheet-record]").click();
  await expect(acc.page.locator(`.cash-sheet-row[data-sheet="${rows[0].sheet_id}"]`)).toContainText("Recorded in Excel");
  const { rows: rec } = await pool.query("SELECT recorded_by FROM cash_sheets WHERE id = $1", [rows[0].sheet_id]);
  expect(rec[0].recorded_by).toBe(accountant.id);
  await acc.context.close();
});
