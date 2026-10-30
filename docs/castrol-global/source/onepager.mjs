// Prints onepager.html to ../KAD_Platform_OnePager.pdf (A4, one page).   Run: node onepager.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const here = new URL("./", import.meta.url).pathname;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("file://" + here + "onepager.html");
await page.waitForTimeout(500);
await page.pdf({ path: here + "../KAD_Platform_OnePager.pdf", format: "A4", printBackground: true, preferCSSPageSize: true });
await page.setViewportSize({ width: 794, height: 1123 });
await page.screenshot({ path: process.env.PREVIEW ?? "/dev/null" }).catch(() => {});
await browser.close();
console.log("saved KAD_Platform_OnePager.pdf");
