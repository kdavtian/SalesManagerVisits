import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-27: Settings > Sales & customers -- the texts the customer reads before signing and the warning on every blank,
// and the default visit frequency per customer type. (Saving the frequencies is covered by docTextsVisitDefaults.test.js: it
// recomputes every customer, which must not happen under the other browser tests running side by side.)
test("admin edits the signature texts and sees the visit frequency per customer type", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const admin = await fixtures.createUser("admin");
  try {
    await loginViaUi(page, admin.email);
    await page.goto("/#/settings?section=a-sales");

    await page.locator("#row-visit-types").click();
    await expect(page.locator('#visit-types-form input[type="number"]')).toHaveCount(14);
    await expect(page.locator('#visit-types-form input[name="gold"]')).toBeVisible();
    if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/settings-visit-types.png`, fullPage: true });
    const noSideways = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(noSideways).toBe(true);
    await page.locator("#admin-section-close").click(); // a phone: the page opens as a full-screen sheet

    await page.locator("#row-doc-texts").click();
    const warning = page.locator('textarea[name="pdf_warning"]');
    await expect(warning).toHaveValue(/whatsapp/);
    await warning.fill("ITest warning");
    await page.locator('#doc-texts-form button[type="submit"]').click();
    await expect(page.locator("#doc-texts-saved")).toBeVisible();
    const { rows } = await pool.query("SELECT document_texts FROM app_settings WHERE id = 1");
    expect(rows[0].document_texts.pdf_warning).toBe("ITest warning");
    // "Restore the original text" + Save: back to the built-in one
    await page.locator('[data-reset="pdf_warning"]').click();
    await expect(warning).toHaveValue(/whatsapp/);
    await page.locator('#doc-texts-form button[type="submit"]').click();
    await expect(page.locator("#doc-texts-saved")).toBeVisible();
    if (process.env.SIG_SHOTS) await page.screenshot({ path: `${process.env.SIG_SHOTS}/settings-doc-texts.png`, fullPage: true });
    const { rows: after } = await pool.query("SELECT document_texts FROM app_settings WHERE id = 1");
    expect(after[0].document_texts.pdf_warning).toBeUndefined();
  } finally {
    await pool.query("UPDATE app_settings SET document_texts = '{}' WHERE id = 1");
  }
});
