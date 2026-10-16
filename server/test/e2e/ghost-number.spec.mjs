import { test, expect, loginViaUi } from "./fixtures.mjs";

// Owner, 2026-10-18: tapping a number field no longer selects everything; it empties the field and keeps the old number
// as a faint ghost (placeholder) so the person sees what it was. Nothing is lost if they type nothing.
test.describe("Number fields: ghost of the old value", () => {
  test("tap empties + ghosts, leaving restores, typing replaces, buttons and Enter restore first", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/dashboard");
    await page.evaluate(async () => {
      const { bindAmdInput } = await import("/js/util.js");
      const host = document.createElement("div");
      host.id = "zz-host";
      host.style.cssText = "position:fixed;top:80px;left:10px;z-index:9999;background:#fff;padding:8px";
      host.innerHTML = `<input id="zz-amd" /><input id="zz-days" inputmode="numeric" value="45" /><button id="zz-btn" type="button">Save</button><span id="zz-out"></span>`;
      document.body.appendChild(host);
      const amd = bindAmdInput(host.querySelector("#zz-amd"));
      amd.set(57000);
      host.querySelector("#zz-btn").addEventListener("click", () => {
        host.querySelector("#zz-out").textContent = `${host.querySelector("#zz-amd").value}|${host.querySelector("#zz-days").value}`;
      });
    });
    const amd = page.locator("#zz-amd");
    const days = page.locator("#zz-days");

    // tap: emptied, old number kept as the ghost
    await amd.click();
    await expect(amd).toHaveValue("");
    await expect(amd).toHaveAttribute("placeholder", "57,000");
    await expect(amd).toHaveClass(/ghost-active/);
    // leave without typing: the number comes back, the placeholder is gone again
    await days.click();
    await expect(amd).toHaveValue("57,000");
    await expect(amd).not.toHaveAttribute("placeholder", /.+/);
    await expect(days).toHaveValue("");
    await expect(days).toHaveAttribute("placeholder", "45");

    // a button tapped while the field is still focused (iOS does not blur) sees the restored values
    await page.locator("#zz-btn").click();
    await expect(page.locator("#zz-out")).toHaveText("57,000|45");

    // typing replaces: no old digits left, and the new value stays after leaving
    await days.click();
    await page.keyboard.type("60");
    await expect(days).toHaveValue("60");
    await amd.click();
    await page.keyboard.type("120000");
    await expect(amd).toHaveValue("120,000");
    await page.locator("#zz-btn").click();
    await expect(page.locator("#zz-out")).toHaveText("120,000|60");

    // Enter restores an untouched field first (so a form submit never reads an empty value)
    await days.click();
    await expect(days).toHaveValue("");
    await page.keyboard.press("Enter");
    await expect(days).toHaveValue("60");
  });
});
