// The monthly competitor price alert (owner, 2026-11-26): on the first days of a month, admin and CEO get one notification listing every
// competitor brand whose median price (same line and volume, clean entries) fell more than 5 % from the month before. Once a month.
import { pool } from "../../db/pool.js";
import { notifyUser } from "../../shared/notifications.js";
import { loadPriceEntries, FLAG_WINDOW_DAYS } from "./marketPrices.js";
import { priceDrops, monthOf, addMonth, marketLines } from "./priceIndex.js";

const nf = (n) => Math.round(n).toLocaleString("en-US");
const vol = (v, unit) => `${Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 })} ${unit === "kg" ? "կգ" : "լ"}`;
const KIND = { wholesale: "մեծ.", retail: "մանր." };
export const MAX_LINES = 8;

// The bullet lines of one alert (Armenian, as every notification)
export function dropBullets(drops) {
  const lines = drops.slice(0, MAX_LINES).map((d) => `• ${d.brand_name} ${d.line_name_hy} ${vol(d.volume, d.unit)}: ${KIND[d.kind]} ${nf(d.before)} → ${nf(d.after)} դր (${d.change_pct}%, ${d.shops} խանութ)`);
  if (drops.length > MAX_LINES) lines.push(`• և ևս ${drops.length - MAX_LINES}`);
  return lines.join("\n");
}

// The month is marked done in memory only after a run that finished (a failed run is tried again next hour); who already got this
// month's alert is read per person, so a run that stopped half-way finishes the rest (independent review).
let checkedMonth = null;
export async function checkPriceDrops(now = new Date(), db = pool) {
  const month = monthOf(now);
  if (checkedMonth === month) return 0;
  const lastMonth = addMonth(month, -1);
  const { rows: people } = await db.query(
    `SELECT u.id FROM users u WHERE u.role IN ('admin', 'ceo') AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = 'market_price_drop' AND n.title LIKE $1)`,
    [`%(${lastMonth})%`]
  );
  let sent = 0;
  if (people.length) {
    // the same window as the report (Reports > Competitor prices), so the alert and the report's "last month" list agree
    const [entries, lines] = await Promise.all([loadPriceEntries({ since: new Date(now.getTime() - FLAG_WINDOW_DAYS * 86400000), until: now, db }), marketLines(db)]);
    const drops = priceDrops(entries, lastMonth, { lines });
    if (drops.length) {
      for (const p of people) {
        await notifyUser(p.id, "market_price_drop", { title: `Մրցակցի գներն իջել են (${lastMonth})`, body: dropBullets(drops), url: "/#/reports?r=market_prices" });
        sent += 1;
      }
    }
  }
  checkedMonth = month;
  return sent;
}
