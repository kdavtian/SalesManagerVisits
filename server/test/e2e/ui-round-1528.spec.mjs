import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07 (1.528.0): the screenshots round. SHOTS=<dir> keeps the pictures for a person to look at.
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);

test("@smoke tasks table: the status chip stays out of the Due column and does not repeat its date", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const rep = await fixtures.createUser("sales_manager");
  const customer = await fixtures.createCustomer({ name: "Ավտո Սերվիս Երևան ՍՊԸ երկար անուն", created_by: admin.id, assigned_manager_id: rep.id });
  const ids = [];
  for (const [title, due] of [["Հավաքագրիր պարտքը՝ Ավտո Սերվիս Երևան ՍՊԸ, 1 250 000 AMD, ուշացած վճարում", -28], ["Call about oil", 0], ["Check products on the shelf", 3]]) {
    ids.push((await pool.query("INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ($1,$2,$3,$4,current_date + $5::int, 'collect_debt') RETURNING id", [title, admin.id, rep.id, customer.id, due])).rows[0].id);
  }
  try {
    await loginViaUi(page, admin.email);
    for (const w of [1440, 1100]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto("/#/tasks");
      const row = page.locator(`.list-row[data-task-id="${ids[0]}"]`);
      await expect(row).toBeVisible({ timeout: 15000 });
      const chip = row.locator(".list-row-bottom .badge").first();
      await expect(chip).toContainText("28");
      await expect(chip).not.toContainText("-20"); // no date in the chip: the Due column has it
      const [chipBox, dueBox] = await Promise.all([chip.boundingBox(), row.locator(".desk-cell").first().boundingBox()]);
      expect(chipBox.x + chipBox.width, `chip ends before the Due column at ${w}`).toBeLessThanOrEqual(dueBox.x + 1);
      await shot(page, `tasks-${w}`);
    }
  } finally {
    await pool.query("DELETE FROM tasks WHERE id = ANY($1)", [ids]);
  }
});

test("@smoke home on a computer: This week's progress sits under Needs attention (no hole beside Today)", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/");
  await expect(page.locator(".home-desk-left #progress-card")).toBeVisible({ timeout: 15000 });
  await shot(page, "home-1440");
  // a phone width puts it back in Home's own flow, visible
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".dashboard-grid > #progress-card")).toBeVisible();
});

test("@smoke settings: the version at the end, Offices in admin settings, no office tick on the customer form", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const place = await fixtures.createCustomer({ name: `Office Test Place ${Date.now()}`, created_by: admin.id });
  try {
    for (const [w, h] of [[390, 844], [1440, 900]]) {
      await page.setViewportSize({ width: w, height: h });
      if (w === 390) await loginViaUi(page, admin.email);
      await page.goto("/#/settings");
      const foot = page.locator(".settings-version-foot:visible");
      await expect(foot).toHaveCount(1, { timeout: 15000 });
      if (w === 390) {
        // at the very end: below every section of the page
        const [footBox, mainBox] = await Promise.all([foot.boundingBox(), page.locator(".settings-main").boundingBox()]);
        expect(footBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
      }
      const version = await page.evaluate(async () => (await import("/js/version.js")).APP_VERSION);
      await expect(foot).toContainText(version);
      await shot(page, `settings-${w}`);
    }
    await page.goto("/#/settings?section=a-sales");
    await page.locator("#row-offices").click();
    await expect(page.locator("#offices-list")).toBeVisible();
    await page.locator("#offices-search").fill(place.name);
    await page.locator(`[data-add="${place.id}"]`).click();
    await expect(page.locator(`#offices-list [data-remove="${place.id}"]`)).toBeVisible();
    expect((await pool.query("SELECT checkin_for_all FROM customers WHERE id = $1", [place.id])).rows[0].checkin_for_all).toBe(true);
    await shot(page, "settings-offices");
    await page.locator(`#offices-list [data-remove="${place.id}"]`).click();
    await expect(page.locator(`#offices-list [data-remove="${place.id}"]`)).toHaveCount(0);
    expect((await pool.query("SELECT checkin_for_all FROM customers WHERE id = $1", [place.id])).rows[0].checkin_for_all).toBe(false);
    // the customer's own edit form no longer has the office tick
    await page.goto(`/#/customers/${place.id}`);
    await page.locator("#edit-customer-btn").click();
    await expect(page.locator('#edit-customer-form input[name="name"]')).toBeVisible();
    await expect(page.locator('#edit-customer-form [name="checkin_for_all"]')).toHaveCount(0);
  } finally {
    await pool.query("UPDATE customers SET checkin_for_all = false WHERE id = $1", [place.id]);
  }
});

test("@smoke map: a file that does not load shows a plain message and a normal button", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  await page.route("**/js/mapSafeRuntime.js", (route) => route.abort());
  await page.route("**/vendor/leaflet/leaflet.js", (route) => route.abort());
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/map");
  const btn = page.locator("#map-load-retry");
  await expect(btn).toBeVisible({ timeout: 25000 });
  const box = await btn.boundingBox();
  expect(box.height).toBeLessThan(70);
  expect(box.width).toBeGreaterThan(100);
  await shot(page, "map-error-1440");
});

test("@smoke weak internet: a read that fails answers with its last saved copy and the banner says how old it is", async ({ page, context, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const customer = await fixtures.createCustomer({ name: `Offline Copy Garage ${Date.now()}`, created_by: admin.id });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  const read = () => page.evaluate(async (id) => (await import("/js/api.js")).api.getCustomer(id).then((c) => c.name, (e) => `ERROR ${e.message}`), customer.id);
  expect(await read()).toBe(customer.name); // online: saved
  await page.waitForTimeout(500); // the copy is written in the background
  await context.setOffline(true);
  try {
    expect(await read()).toBe(customer.name); // offline: the saved copy
    await expect(page.locator("#sync-banner")).toBeVisible();
    await expect(page.locator("#sync-banner")).toContainText(/\d\d:\d\d/);
    await shot(page, "offline-banner-390");
    // a read never saved has no copy: it still fails the way it always did
    const never = await page.evaluate(async () => (await import("/js/api.js")).api.getCustomer(987654321).then(() => "ok", () => "failed"));
    expect(never).toBe("failed");
  } finally {
    await context.setOffline(false);
  }
});
