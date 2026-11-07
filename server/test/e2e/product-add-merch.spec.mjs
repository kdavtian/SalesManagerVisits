import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-11-07: a new product (here a merch item) is made with its category, without a size, with a photo, and it appears on the
// Products page at once; the photo is served small and cached.
test("@smoke New product: merch without a size, with a category and a photo, appears on the Products page", async ({ page, fixtures }) => {
  const admin = await fixtures.createUser("admin");
  const name = `E2E Stand ${Date.now() % 100000}`;
  // a real 40x40 JPEG made in the page, so the upload is a genuine image
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, admin.email);
  await page.goto("/#/pricelist");
  await page.locator("#add-product-btn").click({ timeout: 15000 });
  const sheet = page.locator(".product-add-sheet");
  await sheet.locator('[name="brand"]').fill("Castrol");
  await sheet.locator('[name="name"]').fill(name);
  await sheet.locator('[name="category"]').selectOption("Merch");
  await expect(sheet.locator("#pa-line-wrap")).toBeHidden();
  const jpeg = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 40;
    c.getContext("2d").fillRect(0, 0, 40, 40);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await sheet.locator('[name="photo"]').setInputFiles({ name: "stand.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg) });
  await page.screenshot({ path: "test-results/product-add-merch.png" });
  await sheet.locator("#pa-save").click();
  await expect(page.locator("#pricelist-catalog")).toContainText(name, { timeout: 15000 });
  const { rows } = await pool.query("SELECT id, family, unit, image_path FROM products WHERE name = $1", [name]);
  expect(rows[0].family).toBe("Merch");
  expect(rows[0].unit).toBeNull();
  expect(rows[0].image_path).toBeTruthy();
  const res = await page.request.get(`/api/products/${rows[0].id}/image?w=160&v=${rows[0].image_path}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("immutable");
});
