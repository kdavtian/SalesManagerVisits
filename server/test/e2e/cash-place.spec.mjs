import { test, expect, loginViaUi } from "./fixtures.mjs";
import { pool } from "../../src/db/pool.js";

// Where is the cash now (owner, 2026-11-23): every payment row says ONE thing about its cash, with the same words on the list and the sheet.
test("payments: each row says where its cash is now; the row fits at 390 and 320 px in Armenian", async ({ page, fixtures }) => {
  const rep = await fixtures.createUser("sales_manager", { name: "Արտակ Հակոբյան" });
  const director = await fixtures.createUser("sales_director", { name: "Մարտին Սարգսյան" });
  const accountant = await fixtures.createUser("accountant", { name: "Մանե Պետրոսյան" });
  const admin = await fixtures.createUser("admin");
  const customer = await fixtures.createCustomer({ created_by: rep.id, name: "Ավտոպահեստամասերի խանութ «Արարատ»" });
  const pay = (over) => fixtures.createPayment({ customer_id: customer.id, customer_name_snapshot: customer.name, sales_manager_id: rep.id, sales_manager_name_snapshot: rep.name, ...over });
  const withRep = await pay({ amount_amd: 41000 });
  const onTheWay = await pay({ amount_amd: 42000 });
  const counted = await pay({ amount_amd: 43000, current_holder_id: director.id });
  const office = await pay({ amount_amd: 44000, current_holder_id: accountant.id, status: "approved" });
  await pool.query("UPDATE payments SET approved_by = $2, approved_at = now() WHERE id = $1", [office.id, accountant.id]);
  const { rows: [h] } = await pool.query("INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by) VALUES ($1, $2, 42000, 'pending', $1) RETURNING id", [rep.id, director.id]);
  fixtures.track("cash_handoffs", h.id);
  await pool.query("INSERT INTO cash_handoff_items (handoff_id, payment_id) VALUES ($1, $2)", [h.id, onTheWay.id]);
  await pool.query("UPDATE payments SET pending_handoff_id = $1 WHERE id = $2", [h.id, onTheWay.id]);

  const shots = process.env.GB_SHOTS ?? "/tmp";
  await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/payments?customer_id=${customer.id}`);
  await page.locator('.map-filter-chip[data-filter=""]').first().click(); // All: the approved one too
  const chip = (p) => page.locator(`.pay-row[data-payment-id="${p.id}"] .cash-place-chip`);
  await expect(chip(withRep)).toHaveAttribute("data-cash-place", "with_rep", { timeout: 10000 });
  await expect(chip(withRep)).toContainText("Արտակ");
  await expect(chip(onTheWay)).toHaveAttribute("data-cash-place", "on_the_way");
  await expect(chip(onTheWay)).toContainText("Մարտին");
  await expect(chip(counted)).toHaveAttribute("data-cash-place", "with_director");
  await expect(chip(office)).toHaveAttribute("data-cash-place", "office");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll at ${width}`).toBe(true);
    // every mark stays inside its card
    for (const p of [withRep, onTheWay, counted, office]) {
      const card = await page.locator(`.pay-row[data-payment-id="${p.id}"]`).boundingBox();
      const box = await chip(p).boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 1);
    }
    await page.screenshot({ path: `${shots}/cash-place-list-${width}.png`, fullPage: true });
  }
  // the sheet says the same, and no second "held by" line repeats it
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(`.pay-row[data-payment-id="${onTheWay.id}"] .payment-row-main`).click();
  const sheet = page.locator("body > .sheet-overlay .sheet");
  await expect(sheet.locator(".cash-place-chip")).toHaveAttribute("data-cash-place", "on_the_way", { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/cash-place-sheet-390.png` });
});
