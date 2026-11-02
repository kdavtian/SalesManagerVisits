// A new customer joins its rep's recurring route plan by itself (owner, 2026-11-03): "if Artak has to visit most of the Abovyan
// customers on Tuesday and a new customer from Abovyan is added, it should be added to the Abovyan route plan accordingly".
//   - the rep = the customer's assigned manager; only the live plan (visit_plan_rules, what Map / Home / Vaghinak read) and, when a
//     plan set is active, the same day of that set (so the Route plans screen shows it too);
//   - the day = the weekday that already holds most of this rep's customers of the same subregion (none: of the same region), counted
//     within the same plan (the main plan, or a separately planned channel such as SM B2B -- planScopes.js); a tie goes to the lighter day;
//   - the place in the day = right after the nearest customer of that day (else at the end);
//   - a day that takes the customer's area as a whole (areas) already includes it: nothing is changed, the person is only told;
//   - never for the channels nobody visits (KF, CAS, CVO, PCO, OEM) or the office check-in place, nor when nothing of that area is planned.
// Switch: app_settings.auto_route_plan_new_customers (App configuration, ON by default, migration 178).
import { pool } from "../db/pool.js";
import { NO_VISIT_CHANNELS } from "../customers/routes/customers.js";
import { scopeOfChannel } from "./planScopes.js";
import { distM, hasLocation } from "../orders/routePlanner.js";
import { notifyUser } from "../shared/notifications.js";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_HY = ["Կիրակի", "Երկուշաբթի", "Երեքշաբթի", "Չորեքշաբթի", "Հինգշաբթի", "Ուրբաթ", "Շաբաթ"];

export async function getAutoRoutePlanEnabled(db = pool) {
  const { rows } = await db.query("SELECT auto_route_plan_new_customers FROM app_settings WHERE id = 1");
  return rows[0]?.auto_route_plan_new_customers ?? true;
}

export async function setAutoRoutePlanEnabled(enabled) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, auto_route_plan_new_customers) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET auto_route_plan_new_customers = EXCLUDED.auto_route_plan_new_customers RETURNING auto_route_plan_new_customers`,
    [enabled]
  );
  return rows[0].auto_route_plan_new_customers;
}

const coversArea = (areas, c) => (Array.isArray(areas) ? areas : []).some((a) => a?.region && a.region === c.region && (!a.subregion || a.subregion === c.subregion));

/**
 * Pure choice (tested on its own): rules = [{ day_of_week, customer_ids }], known = Map(id -> { region, subregion, sales_channel, lat, lng }).
 * Returns { day_of_week, by: "subregion" | "region", count, index } (index = where to insert in that day's list) or null.
 */
export function chooseDay(customer, rules, known) {
  const scope = scopeOfChannel(customer.sales_channel);
  const sameScope = (id) => known.has(id) && scopeOfChannel(known.get(id).sales_channel) === scope;
  const score = (rule, by) => rule.customer_ids.filter((id) => sameScope(id) && known.get(id)[by] === customer[by]).length;
  for (const by of customer.subregion ? ["subregion", "region"] : ["region"]) {
    let best = null;
    for (const rule of [...rules].sort((a, b) => WEEK_ORDER.indexOf(a.day_of_week) - WEEK_ORDER.indexOf(b.day_of_week))) {
      const count = score(rule, by);
      if (!count) continue;
      const load = rule.customer_ids.filter(sameScope).length;
      if (!best || count > best.count || (count === best.count && load < best.load)) best = { rule, count, load };
    }
    if (best) return { day_of_week: best.rule.day_of_week, by, count: best.count, index: insertIndex(customer, best.rule.customer_ids, known, by) };
  }
  return null;
}

// Right after the nearest customer of the day (preferring the same area); at the end when nobody has a location.
function insertIndex(customer, ids, known, by) {
  if (!hasLocation(customer)) return ids.length;
  let best = -1;
  let bestD = Infinity;
  for (const [i, id] of ids.entries()) {
    const k = known.get(id);
    if (!k || !hasLocation(k)) continue;
    const d = distM(customer, k) * (k[by] === customer[by] ? 1 : 3);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? ids.length : best + 1;
}

const placed = (ids, id, index) => [...ids.slice(0, index), id, ...ids.slice(index)];

/**
 * Puts a just-created customer into its rep's route plan. Returns what happened, for the person who added it:
 *   { status: "added", day_of_week, rep_id, rep_name, by, area, count } | { status: "in_area", day_of_week, rep_id, rep_name }
 *   | { status: "skipped", reason } -- never throws (the customer is already saved).
 */
export async function placeNewCustomer(customerId, actorId) {
  try {
    if (!(await getAutoRoutePlanEnabled())) return { status: "skipped", reason: "off" };
    const { rows: [c] } = await pool.query(
      `SELECT c.id, c.name, c.region, c.subregion, c.sales_channel, c.checkin_for_all, c.lat::float8 AS lat, c.lng::float8 AS lng, c.visit_frequency_days,
              c.assigned_manager_id AS rep_id, u.name AS rep_name
       FROM customers c LEFT JOIN users u ON u.id = c.assigned_manager_id WHERE c.id = $1`,
      [customerId]
    );
    if (!c?.rep_id) return { status: "skipped", reason: "no_rep" };
    if (!c.region) return { status: "skipped", reason: "no_area" };
    if (NO_VISIT_CHANNELS.includes(c.sales_channel) || c.checkin_for_all) return { status: "skipped", reason: "not_visited" };
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      const { rows: rules } = await client.query("SELECT id, day_of_week, areas, customer_ids FROM visit_plan_rules WHERE user_id = $1 AND active ORDER BY day_of_week FOR UPDATE", [c.rep_id]);
      if (!rules.length) {
        await client.query("ROLLBACK");
        return { status: "skipped", reason: "no_plan" };
      }
      const already = rules.find((r) => coversArea(r.areas, c) || r.customer_ids.includes(c.id));
      if (already) {
        await client.query("ROLLBACK");
        return { status: "in_area", day_of_week: already.day_of_week, rep_id: c.rep_id, rep_name: c.rep_name };
      }
      const ids = [...new Set(rules.flatMap((r) => r.customer_ids))];
      const { rows: others } = await client.query("SELECT id, region, subregion, sales_channel, lat::float8 AS lat, lng::float8 AS lng FROM customers WHERE id = ANY($1)", [ids]);
      const known = new Map(others.map((o) => [o.id, o]));
      const choice = chooseDay(c, rules, known);
      if (!choice) {
        await client.query("ROLLBACK");
        return { status: "skipped", reason: "no_match" };
      }
      const rule = rules.find((r) => r.day_of_week === choice.day_of_week);
      await client.query("UPDATE visit_plan_rules SET customer_ids = $2, updated_at = now() WHERE id = $1", [rule.id, placed(rule.customer_ids, c.id, choice.index)]);
      // the active plan set holds the same plan: the customer goes onto the same day there (after the same neighbour)
      const { rows: [setRule] } = await client.query(
        `SELECT r.set_id, r.customer_ids FROM route_plan_set_rules r JOIN route_plan_sets s ON s.id = r.set_id
         WHERE s.is_active AND r.user_id = $1 AND r.day_of_week = $2 FOR UPDATE OF r`,
        [c.rep_id, choice.day_of_week]
      );
      if (setRule && !setRule.customer_ids.includes(c.id)) {
        const before = rule.customer_ids[choice.index - 1];
        const at = before != null && setRule.customer_ids.includes(before) ? setRule.customer_ids.indexOf(before) + 1 : setRule.customer_ids.length;
        await client.query("UPDATE route_plan_set_rules SET customer_ids = $3 WHERE set_id = $1 AND user_id = $2 AND day_of_week = $4", [setRule.set_id, c.rep_id, placed(setRule.customer_ids, c.id, at), choice.day_of_week]);
        if (c.visit_frequency_days >= 1 && c.visit_frequency_days <= 365) {
          await client.query("INSERT INTO route_plan_set_frequencies (set_id, customer_id, days) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [setRule.set_id, c.id, c.visit_frequency_days]);
        }
      }
      await client.query("COMMIT");
      result = { status: "added", day_of_week: choice.day_of_week, rep_id: c.rep_id, rep_name: c.rep_name, by: choice.by, area: c[choice.by], count: choice.count };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // the rep is told when someone else added the customer (the person who added it sees it on screen)
    if (c.rep_id !== actorId) {
      notifyUser(c.rep_id, "route_plan_added", {
        title: `Նոր հաճախորդ՝ ${DAY_HY[result.day_of_week]}-ի երթուղում`,
        body: `${c.name} (${result.area}) ավելացվեց ${DAY_HY[result.day_of_week]}-ի երթուղային պլանին`,
        url: `/#/customers/${c.id}`,
      }).catch((err) => console.error("Route plan notification failed:", err.message));
    }
    return result;
  } catch (err) {
    console.error("Placing the new customer in a route plan failed:", err.message);
    return { status: "skipped", reason: "error" };
  }
}
