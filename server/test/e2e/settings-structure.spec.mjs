import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-24: "rearrange settings and admin part from 0 ... Apple iOS and macOS styles and structure". Two tabs
// (Personal | Administration), explanations only behind "!", sidebar + page on a computer.
const SHOTS = process.env.SETTINGS_SHOTS; // optional folder for review screenshots

test.describe("Settings structure", () => {
  test("phone: Personal is a list of pages with the explanations behind '!'; Administration is categories that open as pages", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings");

    // Personal: every page is on the one scrolling list, the sidebar list is not shown
    await expect(page.locator('[data-page="p-account"]')).toBeVisible();
    await expect(page.locator('[data-page="p-appearance"]')).toBeVisible();
    await expect(page.locator('[data-page="p-data"]')).toBeVisible();
    await expect(page.locator("#settings-nav-personal")).toBeHidden();
    await expect(page.locator("#settings-logout")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-personal.png`, fullPage: true });

    // the explanation of Efficiency mode is behind its "!"
    await expect(page.locator("#efficiency-mode-hint-text")).toBeHidden();
    await page.locator("#efficiency-mode-hint-btn").click();
    await expect(page.locator("#efficiency-mode-hint-text")).toBeVisible();
    await page.locator("#efficiency-mode-hint-btn").click();
    await expect(page.locator("#efficiency-mode-hint-text")).toBeHidden();

    // Administration: the category list, no page yet
    await page.locator("#settings-admin-tab").click();
    await expect(page.locator("#settings-nav-admin")).toBeVisible();
    await expect(page.locator("[data-nav-page^='a-']")).toHaveCount(7);
    await expect(page.locator("#radius-form")).toBeHidden();
    await expect(page.locator("#settings-logout")).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-admin-list.png`, fullPage: true });

    // open "Sales & customers": its own route, a Back button, the forms; the help texts are behind "!"
    await page.locator('[data-nav-page="a-sales"]').click();
    await expect(page).toHaveURL(/#\/settings\?section=a-sales/);
    await expect(page.locator("#radius-form")).toBeVisible();
    await expect(page.locator("#settings-back")).toBeVisible();
    await expect(page.locator("#settings-title")).toHaveText("Sales & customers");
    await expect(page.locator("#radius-help-text")).toBeHidden();
    await page.locator('#radius-form [data-hint="radius-help-text"]').click();
    await expect(page.locator("#radius-help-text")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-admin-sales.png`, fullPage: true });

    // Back returns to the category list
    await page.locator("#settings-back").click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.locator("#settings-nav-admin")).toBeVisible();
    await expect(page.locator("#radius-form")).toBeHidden();
  });

  test("search finds a setting on any page and opens it", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings");

    await page.locator("#settings-search").fill("password");
    await expect(page.locator("#settings-results .settings-result").first()).toContainText(/password/i);
    await expect(page.locator('[data-page="p-account"]')).toBeHidden(); // results replace the lists while searching
    await page.locator("#settings-search").fill("allowed distance");
    const hit = page.locator("#settings-results .settings-result", { hasText: /Allowed distance/i }).first();
    await expect(hit).toContainText("Sales & customers");
    await hit.click();
    await expect(page.locator("#radius-form")).toBeVisible();
    await expect(page.locator("#settings-search")).toHaveValue("");

    await page.locator("#settings-back").click(); // the page opened from a result goes back to the list
    await page.locator("#settings-search").fill("zzzzqq");
    await expect(page.locator("#settings-search-empty")).toBeVisible();
  });

  test("computer: sidebar + page, the screen of a row replaces the page and Back returns", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings");

    // Personal: the sidebar lists the 5 pages; only the chosen one is shown
    await expect(page.locator("#settings-nav-personal [data-nav-page]")).toHaveCount(5);
    await expect(page.locator('[data-page="p-account"]')).toBeVisible();
    await expect(page.locator('[data-page="p-appearance"]')).toBeHidden();
    await expect(page.locator("#settings-logout")).toBeVisible();
    await page.locator('[data-nav-page="p-appearance"]').click();
    await expect(page.locator("#toggle-appearance")).toBeVisible();
    await expect(page.locator("#settings-logout")).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-personal.png` });

    // Administration: the sidebar lists the categories; the first page opens
    await page.locator("#settings-admin-tab").click();
    await expect(page.locator("#settings-nav-admin [data-nav-page]")).toHaveCount(7);
    await expect(page.locator("#row-team-management")).toBeVisible();
    await page.locator('[data-nav-page="a-finance"]').click();
    await expect(page.locator("#toggle-landing-calc")).toBeVisible();
    await expect(page.locator("#row-team-management")).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-admin-finance.png` });

    // a row's screen replaces the page; Back (named after the page) returns to it
    await page.locator('[data-nav-page="a-team"]').click();
    await page.locator("#row-team-management").click();
    await expect(page.locator("#settings-section-pane")).toBeVisible();
    await expect(page.locator("#row-team-management")).toBeHidden();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/wide-admin-drill.png` });
    await page.locator(".settings-pane-back").click();
    await expect(page.locator("#row-team-management")).toBeVisible();
    await expect(page.locator("#settings-section-pane")).toBeHidden();

    // a theme toggle re-renders the view but keeps the page you were on
    await page.locator("#settings-personal-tab").click();
    await page.locator('[data-nav-page="p-appearance"]').click();
    await page.locator("#toggle-appearance").click();
    await expect(page.locator("#toggle-appearance")).toBeVisible();
    await expect(page.locator('[data-page="p-account"]')).toBeHidden();
    await page.locator("#toggle-appearance").click(); // back to the previous theme
  });

  test("a rep has no Administration; a director sees only the categories that are theirs", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const rep = await fixtures.createUser("sales_manager");
    await loginViaUi(page, rep.email);
    await page.goto("/#/settings");
    await expect(page.locator("#settings-tabs")).toHaveCount(0);
    await expect(page.locator("#settings-admin-panel")).toHaveCount(0);
    await expect(page.locator('[data-page="p-account"]')).toBeVisible();
    await expect(page.locator("#settings-logout")).toBeVisible();

    await page.context().clearCookies();
    const director = await fixtures.createUser("sales_director");
    await loginViaUi(page, director.email);
    await page.goto("/#/settings");
    await page.locator("#settings-admin-tab").click();
    await expect(page.locator('[data-nav-page="a-team"]')).toHaveCount(0);
    await expect(page.locator('[data-nav-page="a-security"]')).toHaveCount(0);
    await expect(page.locator('[data-nav-page="a-sales"]')).toBeVisible();
  });

  // Review screenshots (Armenian, 390 px, dark): only when SETTINGS_SHOTS names a folder.
  test("review screenshots", async ({ page, fixtures }) => {
    test.skip(!SHOTS, "set SETTINGS_SHOTS to take them");
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings");
    await page.locator("#toggle-language").click(); // English -> Armenian
    await expect(page.locator("#settings-title")).not.toHaveText("Settings");
    await page.screenshot({ path: `${SHOTS}/hy-390-personal.png`, fullPage: true });
    await page.locator("#toggle-appearance").click(); // dark
    await page.screenshot({ path: `${SHOTS}/hy-390-personal-dark.png`, fullPage: true });
    await page.locator("#toggle-appearance").click(); // light again
    await page.locator("#settings-admin-tab").click();
    await page.screenshot({ path: `${SHOTS}/hy-390-admin-list.png`, fullPage: true });
    for (const id of ["a-finance", "a-security", "a-integrations"]) {
      await page.goto(`/#/settings?section=${id}`);
      await page.screenshot({ path: `${SHOTS}/hy-390-${id}.png`, fullPage: true });
    }
  });

  test("every role opens every page it is offered without a script error", async ({ page, fixtures }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 860 }); // the sidebar lists every page, one click each
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    for (const role of ["admin", "ceo", "accountant", "sales_director", "sales_manager"]) {
      const user = await fixtures.createUser(role);
      await page.context().clearCookies();
      await loginViaUi(page, user.email);
      await page.goto("/#/settings");
      await expect(page.locator("#settings-title")).toBeVisible();
      for (const tab of ["personal", "admin"]) {
        const tabBtn = page.locator(`#settings-${tab}-tab`);
        if (await tabBtn.count()) await tabBtn.click();
        else if (tab === "admin") continue;
        const ids = await page.locator(`#settings-nav-${tab} [data-nav-page]`).evaluateAll((els) => els.map((el) => el.dataset.navPage));
        expect(ids.length, `${role} ${tab} pages`).toBeGreaterThan(0);
        for (const id of ids) {
          await page.locator(`[data-nav-page="${id}"]`).click();
          await expect(page.locator(`[data-page="${id}"]`)).toBeVisible();
        }
      }
    }
    expect(errors).toEqual([]);
  });

  test("the Administration list shows what is waiting beside a category and on the tab", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 440, height: 956 });
    const admin = await fixtures.createUser("admin");
    const rep = await fixtures.createUser("sales_manager");
    const { rows } = await pool.query(
      "INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, current_date + 401, '{}', 'pending', $1) RETURNING id",
      [rep.id]
    );
    try {
      await loginViaUi(page, admin.email);
      await page.goto("/#/settings");
      await expect(page.locator("#settings-admin-tab-count")).toBeVisible();
      await page.locator("#settings-admin-tab").click();
      const count = page.locator('[data-count-for="a-sales"]');
      await expect(count).toBeVisible();
      expect(Number(await count.textContent())).toBeGreaterThanOrEqual(1);
      await expect(page.locator('[data-count-for="a-security"]')).toBeHidden();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-admin-counts.png` });
    } finally {
      await pool.query("DELETE FROM visit_plans WHERE id = $1", [rows[0].id]);
    }
  });
});
