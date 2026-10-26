import { test, expect, loginViaUi, pool } from "./fixtures.mjs";
import { createRequire } from "node:module";

// Owner, 2026-10-26: one data model for every customer document (signed order blanks, signed acts, payment slips): add from the customer
// card, look at it / turn it upright in the viewer, see it on the linked order, and find it in the Documents inbox.
const require = createRequire(import.meta.url);
const sharp = require("sharp");

test.describe("Documents", () => {
  test("add a document, turn it in the viewer, find it on the order and in the inbox", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const customer = await fixtures.createCustomer({ created_by: admin.id });
    const jpg = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#e8f0e0" } }).jpeg().toBuffer();
    await loginViaUi(page, admin.email);

    // an order the document can be linked to
    const orderId = (await fixtures.createOrder({ customer_id: customer.id, user_id: admin.id, status: "delivered" })).id;

    await page.goto(`/#/customers/${customer.id}`);
    await page.locator("#customer-photos-btn").click();
    await page.locator("#add-document-btn").click();
    await page.locator("#add-file-library").setInputFiles({ name: "blank.jpg", mimeType: "image/jpeg", buffer: jpg });
    await expect(page.locator("#add-file-preview")).toBeVisible();
    await page.locator('[data-turn="90"]').click();
    await page.locator("#add-file-order-list input").first().check();
    const saved = page.waitForResponse((r) => r.url().includes("/api/files/customer/") && r.request().method() === "POST");
    await page.locator("#add-file-save").click();
    expect((await saved).status()).toBe(201);

    // the Files sheet lists it; the viewer opens and turning bumps the version of the picture
    const tile = page.locator(".files-blank").first();
    await expect(tile).toBeVisible();
    await tile.click();
    const img = page.locator(".file-viewer-img");
    await expect(img).toBeVisible();
    const before = await img.getAttribute("src");
    await page.locator('[data-act="rotate-right"]').click();
    await expect.poll(async () => page.locator(".file-viewer-img").getAttribute("src")).not.toBe(before);
    await page.locator(".file-viewer-close").click();

    // the linked order shows it
    const row = await pool.query("SELECT id, kind, order_ids, version FROM customer_files WHERE customer_id = $1", [customer.id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].kind).toBe("order_blank");
    expect(row.rows[0].order_ids).toEqual([orderId]);
    expect(row.rows[0].version).toBe(2);

    // the linked order shows it in its own Documents block
    await page.evaluate(async (id) => (await import("/js/orderDetailSheet.js")).openOrderDetailSheet(id), orderId);
    await expect(page.locator("#order-files-slot .files-blank")).toHaveCount(1);

    // the inbox (admin sees everyone's documents)
    await page.goto("/#/documents");
    await page.locator('[data-period=""]').click();
    await expect(page.locator(".doc-row", { hasText: customer.name }).first()).toBeVisible();
    await page.locator("#doc-kind").selectOption("payment_slip");
    await expect(page.locator(".doc-row", { hasText: customer.name })).toHaveCount(0);
    await page.locator("#doc-kind").selectOption("order_blank");
    await expect(page.locator(".doc-row", { hasText: customer.name }).first()).toBeVisible();
  });
});
