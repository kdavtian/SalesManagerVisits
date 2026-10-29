import { test, expect, loginViaUi } from "./fixtures.mjs";
import { createRequire } from "node:module";

// Owner, 2026-10-30: "I want an iPhone native photo viewer: the current one has no pinch to zoom, not fast". The document viewer zooms
// in place (zoomStage.js): double tap zooms in where tapped and back out, two fingers pinch, a swipe moves to the next document, the
// wheel zooms on a computer, and the screen-size copy of a photo is what it shows (not the full original).
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const scaleOf = (page) => page.locator(".file-viewer-zoom .zoom-stage-img").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

async function pointer(page, type, id, x, y) {
  await page.locator(".file-viewer-zoom").evaluate(
    (el, [type, id, x, y]) => {
      const b = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: b.left + x, clientY: b.top + y, bubbles: true, button: 0 }));
    },
    [type, id, x, y]
  );
}

// both taps in one go: sent one by one, a busy test machine can space them further apart than a double tap allows
async function doubleTap(page, x, y) {
  await page.locator(".file-viewer-zoom").evaluate(
    (el, [x, y]) => {
      const b = el.getBoundingClientRect();
      for (let i = 0; i < 2; i++) {
        for (const type of ["pointerdown", "pointerup"]) {
          el.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: b.left + x, clientY: b.top + y, bubbles: true, button: 0 }));
        }
      }
    },
    [x, y]
  );
}

test("@smoke @iphone document photos: double tap and pinch zoom, swipe to the next, screen-size copy first", async ({ page, fixtures }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await fixtures.createUser("admin");
  const customer = await fixtures.createCustomer({ created_by: admin.id });
  await loginViaUi(page, admin.email);
  await page.goto(`/#/customers/${customer.id}`);
  await page.locator("#customer-photos-btn").click();
  for (const color of ["#d04040", "#4060d0"]) {
    const jpg = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: color } }).jpeg().toBuffer();
    await page.locator("#add-document-btn").click();
    await page.locator("#add-file-library").setInputFiles({ name: "doc.jpg", mimeType: "image/jpeg", buffer: jpg });
    const saved = page.waitForResponse((r) => r.url().includes("/api/files/customer/") && r.request().method() === "POST");
    await page.locator("#add-file-save").click();
    expect((await saved).status()).toBe(201);
  }
  const screenCopy = page.waitForResponse((r) => r.url().includes("/content") && r.url().includes("size=screen"));
  await page.locator(".files-blank").first().click();
  const img = page.locator(".file-viewer-zoom .zoom-stage-img");
  await expect(img).toBeVisible();
  const screen = await screenCopy;
  expect(screen.status()).toBe(200);
  expect(Number(screen.headers()["content-length"] ?? 0)).toBeLessThan(400_000);
  await expect(page.locator(".file-viewer-title")).toContainText("1/2");

  // double tap: zoom in at that spot, double tap again: back
  await doubleTap(page, 150, 300);
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(2);
  await page.waitForTimeout(400);
  await doubleTap(page, 150, 300);
  await expect.poll(() => scaleOf(page)).toBeLessThan(1.05);

  // pinch: two fingers moving apart
  await pointer(page, "pointerdown", 1, 170, 300);
  await pointer(page, "pointerdown", 2, 220, 300);
  for (let d = 0; d <= 120; d += 20) {
    await pointer(page, "pointermove", 1, 170 - d, 300);
    await pointer(page, "pointermove", 2, 220 + d, 300);
  }
  await pointer(page, "pointerup", 1, 50, 300);
  await pointer(page, "pointerup", 2, 340, 300);
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(2);

  // back to normal size, then a swipe left moves to the next document
  await page.waitForTimeout(400);
  await doubleTap(page, 150, 300);
  await expect.poll(() => scaleOf(page)).toBeLessThan(1.05);
  await page.waitForTimeout(400);
  await pointer(page, "pointerdown", 1, 300, 300);
  for (let x = 280; x >= 120; x -= 40) await pointer(page, "pointermove", 1, x, 302);
  await pointer(page, "pointerup", 1, 120, 302);
  await expect(page.locator(".file-viewer-title")).toContainText("2/2");

  // a computer: the wheel zooms where the pointer is (a phone has no wheel)
  if (test.info().project.name === "iphone-webkit") return;
  const box = await page.locator(".file-viewer-zoom").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => scaleOf(page)).toBeGreaterThan(1.5);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/viewer.png` });
});
