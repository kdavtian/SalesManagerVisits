// The monthly competitor price alert (owner, 2026-11-26): on the first days of a month, admin and CEO get one notification listing every
// competitor brand whose median price (same line and volume, clean entries) fell more than 5 % from the month before. Once a month.
import { pool } from "../../db/pool.js";
import { notifyUser } from "../../shared/notifications.js";
import { loadPriceEntries } from "./marketPrices.js";
import { priceDrops, monthOf, addMonth, marketLines } from "./priceIndex.js";

const nf = (n) => Math.round(n).toLocaleString("en-US");
const vol = (v, unit) => `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit === "kg" ? "կգ" : "լ"}`;
const KIND = { wholesale: "մեծ.", retail: "մանր." };
export const MAX_LINES = 8;

// The bullet lines of one alert (Armenian, as every notification)
export function dropBullets(drops) {
  const lines = drops.slice(0, MAX_LINES).map((d) => `• ${d.brand_name} ${d.line_name_hy} ${vol(d.volume, d.unit)}: ${KIND[d.kind]} ${nf(d.before)} → ${nf(d.after)} դր (${d.change_pct}%)`);
  if (drops.length > MAX_LINES) lines.push(`• և ևս ${drops.length - MAX_LINES}`);
  return lines.join("\n");
}

let checkedMonth = null;
export async function checkPriceDrops(now = new Date(), db = pool) {
  const month = monthOf(now);
  if (checkedMonth === month) return 0;
  const lastMonth = addMonth(month, -1);
  // sent already for that month (the title names it)
  const done = await db.query("SELECT 1 FROM notifications WHERE type = 'market_price_drop' AND title LIKE $1 LIMIT 1", [`%(${lastMonth})%`]);
  checkedMonth = month;
  if (done.rowCount) return 0;
  // the two months compared (and a margin of days): what decides the outlier flags too
  const since = new Date(`${addMonth(month, -2)}-01T00:00:00+04:00`);
  const [entries, lines] = await Promise.all([loadPriceEntries({ since, db }), marketLines(db)]);
  const drops = priceDrops(entries, lastMonth, { lines });
  if (!drops.length) return 0;
  const { rows: people } = await db.query("SELECT id FROM users WHERE role IN ('admin', 'ceo') AND status = 'active'");
  for (const p of people) {
    await notifyUser(p.id, "market_price_drop", { title: `Մրցակցի գներն իջել են (${lastMonth})`, body: dropBullets(drops), url: "/#/reports?r=market_prices" });
  }
  return people.length;
}
