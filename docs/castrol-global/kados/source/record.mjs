// Demo screen recordings (LOCAL demo app, demo data): Playwright records each flow, ffmpeg turns it into an H.264 mp4
// that PowerPoint plays. A soft dot shows every tap. Output: ../videos/<name>.mp4 (+ <name>.jpg poster).
//   DECK_BYPASS=deck DECK_PASSWORD=... node record.mjs [name]
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { session, go, browser } from "./shoot.mjs";
const OUT = new URL("../videos/", import.meta.url).pathname;
const TMP = OUT + "_raw/";
mkdirSync(TMP, { recursive: true });
const only = process.argv[2];
const pause = (page, ms) => page.waitForTimeout(ms);
const TAP_DOT = () => {
  const style = document.createElement("style");
  style.textContent = ".deck-tap{position:fixed;z-index:2147483647;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(0,147,67,.35);border:2px solid rgba(0,147,67,.8);pointer-events:none;animation:deckTap .6s ease-out forwards}@keyframes deckTap{from{transform:scale(.5);opacity:1}to{transform:scale(1.4);opacity:0}}";
  document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
  const show = (x, y) => { const d = document.createElement("div"); d.className = "deck-tap"; d.style.left = x + "px"; d.style.top = y + "px"; document.body.appendChild(d); setTimeout(() => d.remove(), 700); };
  addEventListener("pointerdown", (e) => show(e.clientX, e.clientY), true);
};
async function tapIt(page, sel, ms = 900) { await page.locator(sel).first().click({ timeout: 8000 }); await pause(page, ms); }

const FLOWS = {
  "checkin": { user: "aram@kad.demo", run: async (page) => {
    await go(page, "#/customers/16"); await pause(page, 1500);
    await tapIt(page, 'button:has-text("Check In")', 3500);
    await tapIt(page, 'label.outcome-chip:has(input[value="order_placed"])');
    await tapIt(page, 'label.outcome-chip:has(input[value="assortment_check"])');
    await tapIt(page, 'button:has-text("Competitors")');
    await tapIt(page, '.sheet label:has-text("Mobil")', 700); await tapIt(page, '.sheet label:has-text("Shell")', 700);
    await tapIt(page, '.sheet button:has-text("Done")');
    await page.locator("textarea").first().click(); await page.keyboard.type("Owner wants the EDGE range on the front shelf.", { delay: 35 }); await pause(page, 800);
    await page.evaluate(() => document.activeElement?.blur()); await pause(page, 600);
    await tapIt(page, 'button:has-text("Submit check-in")', 3500);
  } },
  "order": { user: "aram@kad.demo", run: async (page) => {
    await go(page, "#/orders/new/16"); await pause(page, 1500);
    await tapIt(page, 'button:has-text("Castrol")', 1200);
    const add = page.locator('button:text-is("Add")');
    for (let i = 0; i < 3; i++) { await add.nth(i).click(); await pause(page, 700); }
    await page.locator('button[aria-label*="Increase"], .oc-plus, button:has-text("+")').first().click().catch(() => {}); await pause(page, 700);
    await tapIt(page, "#order-cart-bar", 1800);
    await tapIt(page, '.sheet button:has-text("Invoice"), button:has-text("Invoice")', 1200);
    await tapIt(page, '#save-order-btn', 3500);
  } },
  "customer": { user: "ceo@kad.demo", run: async (page) => {
    await go(page, "#/customers"); await pause(page, 1200);
    await page.locator('input[type="search"], .search-input input, input[placeholder*="Name"]').first().click(); await page.keyboard.type("Erebuni Auto", { delay: 60 }); await pause(page, 1200);
    await tapIt(page, 'a:has-text("Erebuni Auto Parts"), button:has-text("Erebuni Auto Parts"), .cl-card:has-text("Erebuni Auto Parts"), :text("Erebuni Auto Parts")', 2500);
    await page.mouse.wheel(0, 500); await pause(page, 1500);
    await tapIt(page, '[data-stat="last-order"]', 2500);
    await page.keyboard.press("Escape"); await pause(page, 900);
    await tapIt(page, '[data-stat="debt"]', 2500);
    await page.keyboard.press("Escape"); await pause(page, 900);
    await page.mouse.wheel(0, 600); await pause(page, 1800);
  } },
  "pack": { user: "wh@kad.demo", run: async (page) => {
    await go(page, "#/wh-home"); await pause(page, 1500);
    await tapIt(page, 'button:has-text("Start packing"), a:has-text("Start packing")', 2000);
    const boxes = page.locator('.wp-line input[type="checkbox"], input[type="checkbox"]');
    for (let i = 0; i < 3; i++) { await boxes.nth(i).click({ force: true }).catch(() => {}); await pause(page, 700); }
    await tapIt(page, 'button:has-text("Packed")', 2500);
  } },
};

for (const [name, flow] of Object.entries(FLOWS)) {
  if (only && only !== name) continue;
  const dir = TMP + name + "/"; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const { ctx, page } = await session(flow.user, { video: dir });
  await page.addInitScript(TAP_DOT); await page.reload(); await pause(page, 1500);
  try { await flow.run(page); console.log("recorded", name); } catch (e) { console.log("FLOW FAILED", name, e.message.split("\n")[0]); }
  await pause(page, 1000);
  await ctx.close();
  const webm = dir + readdirSync(dir).find((f) => f.endsWith(".webm"));
  // drop the first 3 s (login), H.264 for PowerPoint, half size to keep the deck small
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "3", "-i", webm, "-vf", "fps=24", "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", OUT + name + ".mp4"]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "5", "-i", OUT + name + ".mp4", "-frames:v", "1", "-q:v", "3", OUT + name + ".jpg"]);
}
await browser.close();
rmSync(TMP, { recursive: true, force: true });
console.log("done");
