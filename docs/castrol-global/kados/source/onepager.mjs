// Prints onepager.html to ../../KAD_OS_OnePager.pdf (A4, one page).   Run: node onepager.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const here = new URL("./", import.meta.url).pathname;
const b = await chromium.launch(); const p = await b.newPage();
await p.goto("file://" + here + "onepager.html"); await p.waitForTimeout(500);
await p.pdf({ path: here + "../../KAD_OS_OnePager.pdf", format: "A4", printBackground: true, preferCSSPageSize: true });
await b.close(); console.log("saved KAD_OS_OnePager.pdf");
