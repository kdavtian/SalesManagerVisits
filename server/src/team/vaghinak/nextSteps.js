// Vaghinak - Sales Expert, step 2 (owner, 2026-11-15): the next step that moves each customer one stage up the funnel (funnel.js), and
// every Monday the 5 most valuable ones per sales manager. Shadow first: the picks are stored and shown to management on the Funnel screen;
// only when management switches salesStepsMode to "live" do they become real tasks for the reps (closed by the rep, like any task).
//
// Rules (no AI, so they cost nothing and every step can be explained):
//   stage 1 potential  - not assessed               -> assess_potential
//                      - Real / High potential       -> first_order (a trial order, the decision maker, prices)
//                      - No / Low, assessed > 60 days -> reassess
//   stage 2 customer   - a product group most shops of the same tier buy and this one does not -> add_group {group}, with the
//                        2 products of that group most of those shops buy (active, not out of stock): "similar shops buy this"
//   stage 3 assortment - no monthly need written     -> ask_need
//                      - a competitor on the shelf   -> raise_share_competitor {brand}
//                      - otherwise                   -> raise_share
//   stage 4 our share  - our litres fell >= 30 % against the window before -> keep_loyal (else nothing to do)
// A counterfeit-restricted customer gets no step (management first). Value: how close the customer is to the next stage, plus its size.
import { pool } from "../../db/pool.js";
import { computeFunnel, PRODUCT_GROUP_SQL } from "./funnel.js";
import { getVaghinakSettings } from "./settings.js";
import { createOpsTask } from "../opsTasks.js";
import { notifyUser } from "../../shared/notifications.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { mondayOf } from "./digest.js";
import { hyCommon } from "../../../../client/public/js/i18n/hy/common.js";
import { minuteOfDay, isWorkingDay } from "./engine.js";

export const PICKS_PER_REP = 5;
const REASSESS_DAYS = 60;
const DROP_SHARE = 0.3;

// The step of one customer. Pure (unit-tested): the funnel row plus the extra facts in, { kind, params, value } out (null = no step).
//   extra: { counterfeit, potentialUpdatedAt, missingGroup, competitor, litresBefore }
export function stepOf(c, extra = {}, now = Date.now()) {
  if (extra.counterfeit) return null;
  const size = Math.min(Number(c.expected_volume_l) || Number(c.litres_month) || 0, 2000) / 2000; // 0..1, a bigger shop counts more
  const near = c.progress == null ? 0.5 : c.progress / 100; // closer to the next stage counts more
  const value = (kindWeight) => Math.round((kindWeight + near + size) * 100);
  if (c.stage === 1) {
    const level = Number(c.potential_level) || 0;
    if (!level) return { kind: "assess_potential", params: {}, value: value(0.8) };
    if (level >= 3) return { kind: "first_order", params: { level }, value: value(level === 4 ? 1.5 : 1.1) };
    const since = extra.potentialUpdatedAt ? (now - new Date(extra.potentialUpdatedAt).getTime()) / 86400000 : Infinity;
    return since > REASSESS_DAYS ? { kind: "reassess", params: { level }, value: value(0.3) } : null;
  }
  if (c.stage === 2) {
    if (!extra.missingGroup) return null;
    const params = { group: extra.missingGroup };
    if (extra.similar?.products?.length) Object.assign(params, extra.similar); // { products: [{ id, name, shops }], buyers }
    return { kind: "add_group", params, value: value(1.2) };
  }
  if (c.stage === 3) {
    if (c.next === "expected_volume_missing") return { kind: "ask_need", params: {}, value: value(0.9) };
    if (extra.competitor) return { kind: "raise_share_competitor", params: { brand: extra.competitor, share: c.share ?? 0 }, value: value(1.3) };
    return { kind: "raise_share", params: { share: c.share ?? 0 }, value: value(1.0) };
  }
  const before = Number(extra.litresBefore) || 0;
  if (before > 0 && Number(c.litres_month) <= before * (1 - DROP_SHARE)) {
    return { kind: "keep_loyal", params: { before: Math.round(before), now: Math.round(Number(c.litres_month) || 0) }, value: value(1.4) };
  }
  return null;
}

// "Similar shops buy this" (pure, unit-tested): the 2 products of a group most shops of the same tier buy (all tiers when no shop of the
// tier buys the group yet), with how many shops buy each and out of how many buying shops. rows: { tier, grp, id, name, shops };
// tierBuyers: tier -> Set(customer). null when nobody buys the group.
export const SIMILAR_PRODUCTS = 2;
export function similarProducts(rows, tier, grp, tierBuyers) {
  const sameTier = rows.some((r) => r.tier === tier && r.grp === grp);
  const byProduct = new Map();
  for (const r of rows) {
    if (r.grp !== grp || (sameTier && r.tier !== tier)) continue;
    const cur = byProduct.get(r.id) ?? { id: r.id, name: r.name, shops: 0 };
    cur.shops += r.shops;
    byProduct.set(r.id, cur);
  }
  const products = [...byProduct.values()].sort((a, b) => b.shops - a.shops || a.name.localeCompare(b.name)).slice(0, SIMILAR_PRODUCTS);
  if (!products.length) return null;
  const buyers = sameTier ? (tierBuyers.get(tier)?.size ?? 0) : [...tierBuyers.values()].reduce((n, set) => n + set.size, 0);
  return { products, buyers: Math.max(buyers, products[0].shops) };
}

// Every open customer's step (with the funnel row), worth most first.
export async function computeNextSteps({ db = pool, now = new Date(), funnel = null } = {}) {
  const { cfg, customers } = funnel ?? (await computeFunnel({ db, settings: await getVaghinakSettings(db) }));
  const ids = customers.map((c) => c.id);
  if (!ids.length) return [];
  const [{ rows: facts }, { rows: groupsBought }, { rows: shelves }, { rows: before }, { rows: productBuyers }] = await Promise.all([
    db.query("SELECT id, counterfeit_flag, potential_updated_at FROM customers WHERE id = ANY($1::int[])", [ids]),
    // which product groups each customer bought in the window (to find the group its tier usually buys and it does not)
    db.query(
      `SELECT c.id AS customer_id, c.customer_tier AS tier, ${PRODUCT_GROUP_SQL("p.family")} AS grp
       FROM customers c JOIN erp_order_lines l ON l.erp_customer_id = c.erp_customer_id
       JOIN products p ON p.erp_product_id = l.product_id
       WHERE c.id = ANY($1::int[]) AND l.qty > 0 AND l.order_date > (now() AT TIME ZONE 'Asia/Yerevan')::date - $2::int
       GROUP BY 1, 2, 3`,
      [ids, cfg.windowDays]
    ),
    // the competitor brands at the customer's last visit that recorded competitors (a visit sends only the groups it filled,
    // so a missing group is "not checked", not "gone"; same rule as the customer card's brand summary)
    db.query(
      `SELECT DISTINCT ON (customer_id) customer_id, brand_status -> 'competitors' AS brands
       FROM checkins WHERE customer_id = ANY($1::int[]) AND jsonb_typeof(brand_status -> 'competitors') = 'array'  -- an empty list = the visit marked every competitor "not available" (2026-11-19): it is the latest state
       ORDER BY customer_id, timestamp DESC`,
      [ids]
    ),
    // litres per month in the window before the current one (stage 4 loyalty check)
    db.query(
      `SELECT c.id AS customer_id, COALESCE(SUM(l.qty * (CASE WHEN regexp_replace(trim(l.size_l), '[Ll]$', '') ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN regexp_replace(trim(l.size_l), '[Ll]$', '')::numeric ELSE 0 END)), 0)::float8 / ($2::float8 / 30) AS litres
       FROM customers c JOIN erp_order_lines l ON l.erp_customer_id = c.erp_customer_id
       WHERE c.id = ANY($1::int[]) AND l.order_date <= (now() AT TIME ZONE 'Asia/Yerevan')::date - $2::int
         AND l.order_date > (now() AT TIME ZONE 'Asia/Yerevan')::date - 2 * $2::int
       GROUP BY 1`,
      [ids, cfg.windowDays]
    ),
    // "similar shops buy this": per tier and group, how many shops bought each product in the window (only products we can still sell)
    db.query(
      `SELECT c.customer_tier AS tier, ${PRODUCT_GROUP_SQL("p.family")} AS grp, p.id, p.name, COUNT(DISTINCT c.id)::int AS shops
       FROM customers c JOIN erp_order_lines l ON l.erp_customer_id = c.erp_customer_id
       JOIN products p ON p.erp_product_id = l.product_id
       WHERE c.id = ANY($1::int[]) AND l.qty > 0 AND l.order_date > (now() AT TIME ZONE 'Asia/Yerevan')::date - $2::int
         AND p.active AND COALESCE(p.stock_qty, 1) > 0
       GROUP BY 1, 2, 3, 4`,
      [ids, cfg.windowDays]
    ),
  ]);
  const factOf = new Map(facts.map((f) => [f.id, f]));
  const shelfOf = new Map(shelves.map((s) => [s.customer_id, s.brands]));
  const beforeOf = new Map(before.map((b) => [b.customer_id, b.litres]));
  // per tier: how many buying customers buy each group; per customer: its groups
  const tierBuyers = new Map(); // tier -> Set(customer)
  const tierGroupCount = new Map(); // `${tier}|${grp}` -> n
  const groupsOf = new Map();
  for (const r of groupsBought) {
    if (!r.grp) continue;
    if (!tierBuyers.has(r.tier)) tierBuyers.set(r.tier, new Set());
    tierBuyers.get(r.tier).add(r.customer_id);
    tierGroupCount.set(`${r.tier}|${r.grp}`, (tierGroupCount.get(`${r.tier}|${r.grp}`) ?? 0) + 1);
    if (!groupsOf.has(r.customer_id)) groupsOf.set(r.customer_id, new Set());
    groupsOf.get(r.customer_id).add(r.grp);
  }
  const missingGroupFor = (c) => {
    const buyers = tierBuyers.get(c.tier)?.size ?? 0;
    if (!buyers) return "Engine oil";
    const mine = groupsOf.get(c.id) ?? new Set();
    const candidates = [...tierGroupCount.entries()]
      .filter(([k]) => k.startsWith(`${c.tier}|`))
      .map(([k, n]) => [k.slice(c.tier.length + 1), n])
      .filter(([g]) => !mine.has(g))
      .sort((a, b) => b[1] - a[1]);
    return candidates[0]?.[0] ?? null;
  };
  const similarFor = (tier, grp) => similarProducts(productBuyers, tier, grp, tierBuyers);
  const steps = [];
  for (const c of customers) {
    const f = factOf.get(c.id) ?? {};
    const brands = shelfOf.get(c.id);
    const missingGroup = c.stage === 2 ? missingGroupFor(c) : null;
    const step = stepOf(
      c,
      {
        counterfeit: f.counterfeit_flag,
        potentialUpdatedAt: f.potential_updated_at,
        missingGroup,
        similar: missingGroup ? similarFor(c.tier, missingGroup) : null,
        competitor: Array.isArray(brands) && brands.length ? String(brands[0]) : null,
        litresBefore: beforeOf.get(c.id),
      },
      now.getTime()
    );
    if (step) steps.push({ customer: c, ...step });
  }
  return steps.sort((a, b) => b.value - a.value);
}

// The text a rep's task carries (Armenian, the reps' language).
const GROUP_HY = { "Engine oil": "շարժիչի յուղ", Transmission: "փոխանցման տուփի յուղ", "Brake fluid": "արգելակային հեղուկ", Hydraulic: "հիդրավլիկ յուղ", Antifreeze: "հակասառիչ", Grease: "քսուք", "EV fluids": "EV հեղուկներ" };
export function taskTitleOf(step) {
  const name = step.customer.name;
  switch (step.kind) {
    case "assess_potential": return `Գնահատիր հեռանկարը՝ ${name}`;
    case "first_order": return `Առաջին պատվեր՝ ${name} (փորձնական պատվեր, գներ, որոշում կայացնողը)`;
    case "reassess": return `Վերագնահատիր հեռանկարը՝ ${name}`;
    case "add_group": {
      const products = (step.params.products ?? []).map((x) => x.name).join(", ");
      return `Առաջարկիր ${GROUP_HY[step.params.group] ?? step.params.group}՝ ${name}${products ? ` (նման խանութները գնում են՝ ${products})` : ""}`;
    }
    case "ask_need": return `Ճշտիր ամսական յուղի պահանջը՝ ${name}`;
    case "raise_share_competitor": return `Մեծացրու մեր բաժինը՝ ${name} (դարակում՝ ${hyCommon[`competitor_${step.params.brand}`] ?? step.params.brand})`;
    case "raise_share": return `Մեծացրու մեր բաժինը՝ ${name}`;
    case "keep_loyal": return `Ստուգիր, ինչու են պատվերները նվազել՝ ${name}`;
    default: return name;
  }
}

// The first working day of the week (from 09:00 Yerevan): this week's 5 best steps per rep, once. The same customer is not picked again while
// its step task is still open or when it was picked in one of the last 2 weeks (the reps get fresh customers). Live mode also gives them as
// tasks (one push per rep, not five). All in one transaction under a lock: the button and the job never pick twice, a failure picks nothing.
const ROTATE_WEEKS = 2;
const checkedEmpty = new Set(); // weeks already found to have nothing to pick (no hourly recompute)
// onlyRepIds: limit the run to these sales managers (tests share one database with other test files)
export async function runWeeklyPicks(now = new Date(), db = pool, { force = false, onlyRepIds = null } = {}) {
  const settings = await getVaghinakSettings(db);
  const day = yerevanToday(now);
  const week = mondayOf(day);
  if (!force) {
    if (settings.mode === "off" || minuteOfDay(now) < 9 * 60 || !(await isWorkingDay(db, day)) || checkedEmpty.has(week)) return { picked: 0 };
  }
  const client = await db.connect();
  const notifications = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sales_step_picks'))");
    const { rowCount: done } = await client.query("SELECT 1 FROM sales_step_picks WHERE week_start = $1 LIMIT 1", [week]);
    if (done) {
      await client.query("ROLLBACK");
      return { picked: 0 };
    }
    const steps = await computeNextSteps({ db: client, now });
    const { rows: reps } = await client.query("SELECT id FROM users WHERE role = 'sales_manager' AND status = 'active'");
    const repIds = new Set(reps.map((r) => r.id).filter((id) => !onlyRepIds || onlyRepIds.includes(id)));
    const { rows: busy } = await client.query(
      `SELECT customer_id FROM tasks WHERE auto_kind = 'sales_step' AND status = 'open'
       UNION SELECT customer_id FROM sales_step_picks WHERE week_start >= $1::date - 7 * $2::int`,
      [week, ROTATE_WEEKS]
    );
    const skip = new Set(busy.map((r) => r.customer_id));
    const perRep = new Map();
    for (const s of steps) {
      const rep = s.customer.rep_id;
      if (!repIds.has(rep) || skip.has(s.customer.id)) continue;
      const list = perRep.get(rep) ?? [];
      if (list.length < PICKS_PER_REP) list.push(s);
      perRep.set(rep, list);
    }
    const live = settings.salesStepsMode === "live";
    let picked = 0;
    for (const [rep, list] of perRep) {
      for (const s of list) {
        const taskId = live
          ? await createOpsTask({ kind: "sales_step", title: taskTitleOf(s), assigneeId: rep, customerId: s.customer.id, dueIsNextVisit: true, notify: false, db: client })
          : null;
        await client.query(
          `INSERT INTO sales_step_picks (week_start, customer_id, rep_id, kind, params, value, task_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (week_start, customer_id) DO NOTHING`,
          [week, s.customer.id, rep, s.kind, JSON.stringify(s.params), s.value, taskId]
        );
        picked++;
      }
      if (live) notifications.push({ rep, n: list.length });
    }
    await client.query("COMMIT");
    if (!picked) checkedEmpty.add(week);
    for (const { rep, n } of notifications) {
      notifyUser(rep, "task_assigned", { title: `Վաղինակ՝ այս շաբաթվա ${n} քայլը`, body: "Վաճառքի քայլեր քո հաճախորդների համար", url: "/#/tasks" }).catch(() => {});
    }
    return { picked, live };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
