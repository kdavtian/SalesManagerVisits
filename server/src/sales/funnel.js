// Vaghinak - Sales Expert, step 1 (owner, 2026-11-15): the sales funnel. Every open customer stands on one of four stages:
//   1 Potential   - a potential customer, moved through the potential levels No / Low / Real / High (customers.potential_level 1-4);
//   2 Customer    - buys from us and has a tier (Bronze / Silver / Gold);
//   3 Assortment  - buys enough product GROUPS from us (engine oil, transmission, brake fluid, hydraulic, antifreeze, grease, EV fluids) in the
//                   last N days for its tier (settings: Bronze 2, Silver 4, Gold 6 by default);
//   4 Our share   - (and stage 3) our litres per month over the same window reach X % of the customer's whole monthly need, the "expected
//                   volume" the rep writes on the customer (setting, 60 % by default). No expected volume = stage 4 cannot be measured yet.
// Sales come from the Excel order lines (the trusted truth). Competitors and closed customers are not on the funnel.
// Each customer also gets its progress towards the NEXT stage (0-100 %), and the funnel remembers every move up or down (funnel job).
import { pool } from "../db/pool.js";
import { getVaghinakSettings, DEFAULTS as VAGHINAK_DEFAULTS } from "../team/vaghinak/settings.js";

// Product group of a catalog product, from its workbook family -- the same rule as the app's catalog (client productBrowse.js productCategory):
// the named non-engine families are their own group, Castrol ON is EV fluids, "Transmission oils" is Transmission, every other family is engine oil.
// Merch and Other are not oil groups and never count.
export const PRODUCT_GROUPS = ["Engine oil", "Transmission", "Brake fluid", "Hydraulic", "Antifreeze", "Grease", "EV fluids"];
export const PRODUCT_GROUP_SQL = (family) => `(CASE
  WHEN lower(trim(coalesce(${family}, ''))) = 'on' THEN 'EV fluids'
  WHEN lower(trim(coalesce(${family}, ''))) IN ('transmission', 'transmission oils') THEN 'Transmission'
  WHEN lower(trim(coalesce(${family}, ''))) = 'brake fluid' THEN 'Brake fluid'
  WHEN lower(trim(coalesce(${family}, ''))) = 'hydraulic' THEN 'Hydraulic'
  WHEN lower(trim(coalesce(${family}, ''))) = 'antifreeze' THEN 'Antifreeze'
  WHEN lower(trim(coalesce(${family}, ''))) = 'grease' THEN 'Grease'
  WHEN lower(trim(coalesce(${family}, ''))) = 'ev fluids' THEN 'EV fluids'
  WHEN lower(trim(coalesce(${family}, ''))) IN ('merch', 'other') THEN NULL
  ELSE 'Engine oil' END)`;

// "4L" / "4" / "0.5L" -> litres; anything else 0 (the same rule as Ask KAD's sales tool).
const SIZE_SQL = (col) => `(CASE WHEN regexp_replace(trim(${col}), '[Ll]$', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN regexp_replace(trim(${col}), '[Ll]$', '')::numeric ELSE 0 END)`;

// (the numbers live with Vaghinak's other settings, editable on his page)
export const FUNNEL_DEFAULTS = Object.fromEntries(Object.entries(VAGHINAK_DEFAULTS).filter(([k]) => k.startsWith("funnel")));

export function funnelSettingsOf(settings = {}) {
  const pick = (k) => (Number.isFinite(Number(settings[k])) && Number(settings[k]) > 0 ? Number(settings[k]) : FUNNEL_DEFAULTS[k]);
  return {
    groupsTarget: { bronze: pick("funnelGroupsBronze"), silver: pick("funnelGroupsSilver"), gold: pick("funnelGroupsGold") },
    sharePct: Math.min(pick("funnelSharePct"), 100),
    windowDays: Math.min(pick("funnelWindowDays"), 365),
  };
}

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Where one customer stands. Pure: the numbers in, the stage and the progress out (unit-tested).
//   c: { tier, potential_level, groups, litres_month, expected_volume_l }
export function stageOf(c, cfg) {
  if (c.tier === "potential") {
    const level = Number(c.potential_level) || 0; // 0 = not assessed yet
    return { stage: 1, progress: clampPct((level / 4) * 100), next: "first_order" };
  }
  const target = cfg.groupsTarget[c.tier] ?? cfg.groupsTarget.bronze;
  const groups = Number(c.groups) || 0;
  if (groups < target) return { stage: 2, progress: clampPct((groups / target) * 100), next: "more_groups" };
  const expected = Number(c.expected_volume_l) || 0;
  if (!(expected > 0)) return { stage: 3, progress: null, next: "expected_volume_missing" };
  const share = ((Number(c.litres_month) || 0) / expected) * 100;
  if (share < cfg.sharePct) return { stage: 3, progress: clampPct((share / cfg.sharePct) * 100), share: Math.round(share), next: "more_share" };
  return { stage: 4, progress: 100, share: Math.round(share), next: "keep" };
}

// Every open, non-competitor customer with its stage.
export async function computeFunnel({ db = pool, settings } = {}) {
  const cfg = funnelSettingsOf(settings ?? (await getVaghinakSettings(db)));
  const { rows } = await db.query(
    `WITH sales AS (
       SELECT l.erp_customer_id,
              COUNT(DISTINCT ${PRODUCT_GROUP_SQL("p.family")}) AS groups,
              COALESCE(SUM(l.qty * ${SIZE_SQL("l.size_l")}), 0) AS litres
       FROM erp_order_lines l
       LEFT JOIN products p ON p.erp_product_id = l.product_id
       WHERE l.order_date > current_date - $1::int
       GROUP BY l.erp_customer_id
     )
     SELECT c.id, c.name, c.customer_tier AS tier, c.potential_level, c.expected_volume_l, c.region, c.subregion,
            c.assigned_manager_id AS rep_id, u.name AS rep_name,
            COALESCE(s.groups, 0)::int AS groups, COALESCE(s.litres, 0)::float8 AS litres
     FROM customers c
     LEFT JOIN users u ON u.id = c.assigned_manager_id
     LEFT JOIN sales s ON s.erp_customer_id = c.erp_customer_id
     WHERE c.closed_at IS NULL AND c.customer_tier IS DISTINCT FROM 'competitor'
     ORDER BY c.name`,
    [cfg.windowDays]
  );
  const months = cfg.windowDays / 30;
  return {
    cfg,
    customers: rows.map((r) => {
      const litresMonth = Math.round((r.litres / months) * 10) / 10;
      return { ...r, litres_month: litresMonth, ...stageOf({ ...r, litres_month: litresMonth }, cfg) };
    }),
  };
}

// The job: remember the stage of every customer and log each move (up or down) so the screen can show this month's movement and how long a
// customer has been stuck. The first run only records where everybody stands (no moves).
export async function recordFunnelMoves({ db = pool } = {}) {
  const { customers } = await computeFunnel({ db });
  const { rows: known } = await db.query("SELECT customer_id, stage FROM customer_funnel_stage");
  const before = new Map(known.map((r) => [r.customer_id, r.stage]));
  let moves = 0;
  for (const c of customers) {
    const prev = before.get(c.id);
    if (prev === c.stage) continue;
    await db.query(
      `INSERT INTO customer_funnel_stage (customer_id, stage, since) VALUES ($1, $2, now())
       ON CONFLICT (customer_id) DO UPDATE SET stage = EXCLUDED.stage, since = now()`,
      [c.id, c.stage]
    );
    if (prev !== undefined) {
      await db.query("INSERT INTO customer_funnel_moves (customer_id, from_stage, to_stage) VALUES ($1, $2, $3)", [c.id, prev, c.stage]);
      moves++;
    }
  }
  return { customers: customers.length, moves };
}
