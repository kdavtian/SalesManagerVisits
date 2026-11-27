// The monthly market report (owner, 2026-11-26): on the 1st (from 10:00 Yerevan) admin and CEO get one short bullet summary of last month
// through the usual notifications -- Castrol's shelf share and its change, the competitor that moved most, price drops, fake / grey spots,
// the reps' market data score. Pure summary (summaryBullets) + one job (checkMonthlyMarketReport), once a month per person.
import { pool } from "../../db/pool.js";
import { notifyUser } from "../../shared/notifications.js";
import { shelfShare, CASTROL } from "./shelfShare.js";
import { loadPriceEntries, marketQuality, FLAG_WINDOW_DAYS } from "./marketPrices.js";
import { priceDrops, monthOf, addMonth, marketLines } from "./priceIndex.js";
import { competitorNameHy } from "./names.js";

const SEND_HOUR = 10;
// sent on the 1st; a server that was down then catches up until this day, never later in the month (a mid-month deploy sends nothing)
const LAST_DAY = 3;
const signed = (n) => (n == null ? "" : n > 0 ? ` (+${n})` : n < 0 ? ` (${n})` : " (0)");
const pctOf = (d, key) => d?.brands?.find((b) => b.key === key)?.numeric_pct ?? (d?.shops ? 0 : null);

// Pure: the bullet lines from the month's facts.
//   share: { now: { shops, castrol_pct, castrol_weighted_pct }, before: {...} }, mover: { name, now_pct, change } | null,
//   drops: priceDrops rows, flagged: { total, fake }, quality: { score } | null, month: "2026-11"
export function summaryBullets({ share, mover, drops, flagged, quality }) {
  const lines = [];
  if (share?.now?.shops) {
    const n = share.now;
    const b = share.before;
    const d = (k) => (b?.shops && n[k] != null && b[k] != null ? n[k] - b[k] : null);
    const weighted = n.castrol_weighted_pct != null ? `, ${n.castrol_weighted_pct}%${signed(d("castrol_weighted_pct"))} ըստ լիտրի` : "";
    lines.push(`Castrol դարակում՝ ${n.castrol_pct ?? 0}%${signed(d("castrol_pct"))} խանութների${weighted} (${n.shops} խանութ)`);
  } else {
    lines.push("Դարակի թարմ տվյալ չկա");
  }
  if (mover) lines.push(`Ամենաշատը փոխվել է՝ ${mover.name} ${mover.now_pct}%${signed(mover.change)}`);
  if (drops.length) {
    const top = drops[0];
    lines.push(`Գներն իջել են՝ ${drops.length} ապրանքանիշ/գիծ, ամենաշատը՝ ${top.brand_name} ${top.line_name_hy} ${top.change_pct}%`);
  } else {
    lines.push("Մրցակցի գների զգալի անկում չկա");
  }
  if (flagged.total) lines.push(`Կեղծ / գորշ Castrol՝ ${flagged.total} խանութ (կեղծ՝ ${flagged.fake})`);
  if (quality?.score != null) lines.push(`Տվյալների որակ՝ ${quality.score}/100`);
  return lines.map((l) => `• ${l}`).join("\n");
}

// Pure: the competitor whose numeric share changed most between two distributions (ties: the bigger one); null when none moved.
export function biggestMover(now, before, nameOf = (k) => k) {
  if (!now?.shops || !before?.shops) return null;
  const skip = new Set([CASTROL, "castrol_fake", "castrol_grey", "lotos", "royal"]);
  const keys = new Set([...now.brands, ...before.brands].map((b) => b.key).filter((k) => !skip.has(k)));
  let best = null;
  for (const k of keys) {
    const a = pctOf(now, k);
    const b = pctOf(before, k);
    const change = (a ?? 0) - (b ?? 0);
    if (!change) continue;
    if (!best || Math.abs(change) > Math.abs(best.change) || (Math.abs(change) === Math.abs(best.change) && a > best.now_pct)) best = { key: k, name: nameOf(k), now_pct: a ?? 0, change };
  }
  return best;
}

// The facts of `month` (default: last month), as of its last moment.
export async function monthlyMarketFacts({ now = new Date(), db = pool } = {}) {
  const month = addMonth(monthOf(now), -1);
  const end = new Date(`${addMonth(month, 1)}-01T00:00:00+04:00`);
  const prevEnd = new Date(`${month}-01T00:00:00+04:00`);
  const [atEnd, atPrev, entries, lines, quality, { rows: names }] = await Promise.all([
    shelfShare({ now: end, db }),
    shelfShare({ now: prevEnd, db }),
    loadPriceEntries({ since: new Date(end.getTime() - FLAG_WINDOW_DAYS * 86400000), until: end, db }),
    marketLines(db),
    marketQuality({ since: prevEnd, until: end, db, flaggedLimit: 0 }),
    db.query("SELECT key, name FROM competitor_brands"),
  ]);
  const brandName = new Map(names.map((n) => [n.key, n.name]));
  const castrol = (s) => ({ shops: s.totals.shops, castrol_pct: pctOf(s.totals, CASTROL), castrol_weighted_pct: s.totals.brands.find((b) => b.key === CASTROL)?.weighted_pct ?? (s.totals.weighted_base ? 0 : null) });
  return {
    month,
    share: { now: castrol(atEnd), before: castrol(atPrev) },
    mover: biggestMover(atEnd.totals, atPrev.totals, (k) => competitorNameHy(k, brandName)),
    drops: priceDrops(entries, month, { lines }),
    flagged: { total: atEnd.flagged.length, fake: atEnd.flagged.filter((f) => f.fake).length },
    quality: quality.totals,
  };
}

// The job: the 1st of a month from SEND_HOUR, once per person (the title names the month); a failed run is tried again next hour.
let doneMonth = null;
export async function checkMonthlyMarketReport(now = new Date(), db = pool) {
  const month = monthOf(now);
  if (doneMonth === month) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", hourCycle: "h23" }).format(now));
  const day = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", day: "numeric" }).format(now));
  if (day > LAST_DAY) {
    doneMonth = month;
    return 0;
  }
  if (day === 1 && hour < SEND_HOUR) return 0;
  const last = addMonth(month, -1);
  const { rows: people } = await db.query(
    `SELECT u.id FROM users u WHERE u.role IN ('admin', 'ceo') AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.type = 'market_monthly' AND n.title LIKE $1)`,
    [`%(${last})%`]
  );
  let sent = 0;
  if (people.length) {
    const facts = await monthlyMarketFacts({ now, db });
    const body = summaryBullets(facts);
    for (const p of people) {
      await notifyUser(p.id, "market_monthly", { title: `Շուկայի ամսական ամփոփում (${last})`, body, url: "/#/reports?r=market_shelf" });
      sent += 1;
    }
  }
  doneMonth = month;
  return sent;
}
