// Vaghinak - Sales Expert, step 2 (owner, 2026-11-15): the next step that moves each customer one stage up the funnel (funnel.js), and
// every Monday the 5 most valuable ones per sales manager. Shadow first: the picks are stored and shown to management on the Funnel screen;
// only when management switches salesStepsMode to "live" do they become real tasks for the reps (closed by the rep, like any task).
//
// Rules (no AI, so they cost nothing and every step can be explained):
//   stage 1 potential  - not assessed               -> assess_potential
//                      - Real / High potential       -> first_order (a trial order, the decision maker, prices)
//                      - No / Low, assessed > 60 days -> reassess
//   stage 2 customer   - a product group most shops of the same tier buy and this one does not -> add_group {group}
//   stage 3 assortment - no monthly need written     -> ask_need
//                      - a competitor on the shelf   -> raise_share_competitor {brand}
//                      - otherwise                   -> raise_share
//   stage 4 our share  - our litres fell >= 30 % against the window before -> keep_loyal (else nothing to do)
// A counterfeit-restricted customer gets no step (management first). Value: how close the customer is to the next stage, plus its size.
import { pool } from "../../db/pool.js";
import { computeFunnel, PRODUCT_GROUP_SQL } from "./funnel.js";
import { getVaghinakSettings } from "./settings.js";
import { createOpsTask } from "../opsTasks.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { mondayOf } from "./digest.js";
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
  if (c.stage === 2) return extra.missingGroup ? { kind: "add_group", params: { group: extra.missingGroup }, value: value(1.2) } : null;
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

// Every open customer's step (with the funnel row), worth most first.
export async function computeNextSteps({ db = pool, now = new Date() } = {}) {
  const settings = await getVaghinakSettings(db);
  const { cfg, customers } = await computeFunnel({ db, settings });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return [];
  const [{ rows: facts }, { rows: groupsBought }, { rows: shelves }, { rows: before }] = await Promise.all([
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
    // the competitor brands seen on the shelf at the customer's last visit that recorded them
    db.query(
      `SELECT DISTINCT ON (customer_id) customer_id, brand_status -> 'competitors' AS brands
       FROM checkins WHERE customer_id = ANY($1::int[]) AND jsonb_typeof(brand_status -> 'competitors') = 'array'
         AND jsonb_array_length(brand_status -> 'competitors') > 0
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
  const steps = [];
  for (const c of customers) {
    const f = factOf.get(c.id) ?? {};
    const brands = shelfOf.get(c.id);
    const step = stepOf(
      c,
      {
        counterfeit: f.counterfeit_flag,
        potentialUpdatedAt: f.potential_updated_at,
        missingGroup: c.stage === 2 ? missingGroupFor(c) : null,
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
    case "add_group": return `Առաջարկիր ${GROUP_HY[step.params.group] ?? step.params.group}՝ ${name}`;
    case "ask_need": return `Ճշտիր ամսական յուղի պահանջը՝ ${name}`;
    case "raise_share_competitor": return `Մեծացրու մեր բաժինը՝ ${name} (դարակում՝ ${step.params.brand})`;
    case "raise_share": return `Մեծացրու մեր բաժինը՝ ${name}`;
    case "keep_loyal": return `Ստուգիր, ինչու են պատվերները նվազել՝ ${name}`;
    default: return name;
  }
}

// Monday (working day, from 09:00 Yerevan): this week's 5 best steps per rep, once. Live mode also gives them as tasks.
export async function runWeeklyPicks(now = new Date(), db = pool, { force = false } = {}) {
  const settings = await getVaghinakSettings(db);
  const day = yerevanToday(now);
  const week = mondayOf(day);
  if (!force) {
    if (settings.mode === "off" || day !== week || minuteOfDay(now) < 9 * 60 || !(await isWorkingDay(db, day))) return { picked: 0 };
  }
  const { rowCount: done } = await db.query("SELECT 1 FROM sales_step_picks WHERE week_start = $1 LIMIT 1", [week]);
  if (done) return { picked: 0 };
  const steps = await computeNextSteps({ db, now });
  const { rows: reps } = await db.query("SELECT id FROM users WHERE role = 'sales_manager' AND status = 'active'");
  const repIds = new Set(reps.map((r) => r.id));
  const perRep = new Map();
  for (const s of steps) {
    const rep = s.customer.rep_id;
    if (!repIds.has(rep)) continue;
    const list = perRep.get(rep) ?? [];
    if (list.length < PICKS_PER_REP) list.push(s);
    perRep.set(rep, list);
  }
  const live = settings.salesStepsMode === "live";
  let picked = 0;
  for (const [rep, list] of perRep) {
    for (const s of list) {
      let taskId = null;
      if (live) {
        taskId = await createOpsTask({ kind: "sales_step", title: taskTitleOf(s), assigneeId: rep, customerId: s.customer.id, dueIsNextVisit: true, db });
      }
      await db.query(
        `INSERT INTO sales_step_picks (week_start, customer_id, rep_id, kind, params, value, task_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (week_start, customer_id) DO NOTHING`,
        [week, s.customer.id, rep, s.kind, JSON.stringify(s.params), s.value, taskId]
      );
      picked++;
    }
  }
  return { picked, live };
}
