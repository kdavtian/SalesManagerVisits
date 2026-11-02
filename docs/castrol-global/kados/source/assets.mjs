// Renders assistant.html (the KAD OS Executive Assistant evening report, demo values) to ../screenshots/raw/assistant.png.
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const D = new URL("./", import.meta.url).pathname;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
await p.goto("file://" + D + "assistant.html"); await p.waitForTimeout(300);
await p.screenshot({ path: D + "../screenshots/raw/assistant.png" });
await b.close(); console.log("saved assistant.png");
