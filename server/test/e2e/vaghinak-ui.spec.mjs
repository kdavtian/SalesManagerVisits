import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-18: no one-sided blue border on unread messages; opening "Open questions" from the Today card must bring
// the Questions chip into view in the swipeable chip row.
test.describe("Vaghinak page", () => {
  test("unread message = dot (no blue side border); Today card -> Questions scrolls the chip row", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    await page.addInitScript(() => localStorage.setItem("fieldvisits_lang", "hy"));
    const rep = { user_id: 1, name: "Rep", plannedCount: 4, visitedPlanned: 1, flags: [], open_questions: 5, muted: false };
    await page.route("**/api/vaghinak/pulse", (route) => route.fulfill({ json: { reps: [rep], settings: { mode: "live" }, nowMin: 1275, day: "2026-10-18" } }));
    await page.route("**/api/vaghinak/qa", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/vaghinak/inbox", (route) =>
      route.fulfill({ json: { badge: 1, messages: [{ id: 1, body: "Hello", created_at: new Date().toISOString(), read_at: null, needs_answer: false }, { id: 2, body: "Old", created_at: new Date().toISOString(), read_at: new Date().toISOString(), needs_answer: false }] } })
    );
    await loginViaUi(page, admin.email);
    await page.goto("/#/vaghinak");
    const unread = page.locator(".vg-msg.vg-unread");
    await expect(unread).toHaveCount(1, { timeout: 10000 });
    await expect(unread.locator(".vg-unread-dot")).toHaveCount(1);
    expect(await unread.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe(await page.locator(".vg-msg:not(.vg-unread)").evaluate((el) => getComputedStyle(el).borderLeftWidth));

    await page.locator('.vg-stat[data-go="qa"]').click();
    const chip = page.locator('.vg-chip[data-tab="qa"]');
    await expect(chip).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(700);
    const box = await chip.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
  });
});
