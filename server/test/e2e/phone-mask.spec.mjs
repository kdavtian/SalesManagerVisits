import { test, expect, loginViaUi, pool } from "./fixtures.mjs";

// Owner, 2026-10-18: "I cannot type number 6 on customer 10166's phone". The mask used to throw the caret to the end after
// every key and cut the last digit off a full number, so editing inside a saved number swallowed digits. Every digit must
// be typeable at every position.
test.describe("Phone typing mask", () => {
  test("every digit can be typed anywhere in a saved number; backspace over spaces works; caret stays put", async ({ page, fixtures }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const admin = await fixtures.createUser("admin");
    const customer = await fixtures.createCustomer({ created_by: admin.id, name: "Phone Mask Customer" });
    await pool.query("UPDATE customers SET phone = '+37491007019' WHERE id = $1", [customer.id]);
    await loginViaUi(page, admin.email);
    await page.goto(`/#/customers/${customer.id}`);
    await page.locator("#edit-customer-btn").click();
    const input = page.locator('#edit-customer-form input[name="phone"]');
    await expect(input).toHaveValue("+374 91 007 019");
    const place = (value, pos) => input.evaluate((el, [v, p]) => { el.value = v; el.focus(); el.setSelectionRange(p, p); }, [value, pos]);
    const read = () => input.evaluate((el) => [el.value, el.selectionStart]);

    // a digit typed inside a full number replaces the next digit and the caret stays right after it
    for (const ch of "0123456789") {
      await place("+374 91 007 019", 12);
      await page.keyboard.type(ch);
      expect(await read()).toEqual([`+374 91 007 ${ch}19`, 13]);
    }
    await place("+374 91 007 019", 8);
    await page.keyboard.type("6");
    expect(await read()).toEqual(["+374 91 607 019", 9]);

    // several digits in a row in the middle of a short number stay in order
    await place("+374 91 007", 8);
    await page.keyboard.type("666");
    expect(await read()).toEqual(["+374 91 666 007", 11]);

    // backspace right after a space removes the digit before it
    await place("+374 91 007 019", 8);
    await page.keyboard.press("Backspace");
    expect((await read())[0]).toBe("+374 90 070 19");

    // a whole number typed after the pre-filled +374, then select-all and replace
    await place("+374 ", 5);
    await page.keyboard.type("96666666");
    expect((await read())[0]).toBe("+374 96 666 666");
    await input.click({ clickCount: 3 });
    await page.keyboard.type("65");
    expect((await read())[0]).toBe("+374 65");
  });

  test("amount fields keep the caret while typing in the middle (57,000)", async ({ page, fixtures }) => {
    const admin = await fixtures.createUser("admin");
    await loginViaUi(page, admin.email);
    await page.goto("/#/dashboard");
    const result = await page.evaluate(async () => {
      const { bindAmdInput } = await import("/js/util.js");
      const input = document.createElement("input");
      input.id = "zz-amd-test";
      document.body.appendChild(input);
      bindAmdInput(input);
      return { input: !!input };
    });
    expect(result.input).toBe(true);
    const el = page.locator("#zz-amd-test");
    await el.click();
    await page.keyboard.type("57000");
    expect(await el.inputValue()).toBe("57,000");
    await el.evaluate((i) => i.setSelectionRange(2, 2));
    await page.keyboard.type("6");
    expect(await el.evaluate((i) => [i.value, i.selectionStart])).toEqual(["576,000", 3]);
    await page.keyboard.type("1");
    expect(await el.evaluate((i) => [i.value, i.selectionStart])).toEqual(["5,761,000", 5]);
  });
});
