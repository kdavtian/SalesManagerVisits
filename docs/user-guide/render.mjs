// HTML -> PDF with the repo's Playwright (server/node_modules). Output goes to
// client/public/docs/kad-motors-guide-{hy,en}.pdf (the files Settings opens).
import { chromium } from "../../server/node_modules/playwright/index.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const build = process.argv[2] ?? path.join(here, "build");
const outDir = path.join(here, "../../client/public/docs");
const exe = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
for (const lang of ["hy", "en"]) {
  const page = await browser.newPage();
  await page.goto("file://" + path.join(build, `guide-${lang}.html`));
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: path.join(outDir, `kad-motors-guide-${lang}.pdf`),
    preferCSSPageSize: true,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate: `<div style="width:100%;font-size:7px;color:#667089;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
  });
  console.log("pdf", lang);
}
await browser.close();
