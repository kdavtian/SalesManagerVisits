// Route plan sets: whole route plans (every rep x weekday -> ordered customers + visit frequency) that can be
// generated automatically, edited, duplicated and switched. The ACTIVE set is mirrored into visit_plan_rules and
// customers.visit_frequency_days, which is what the rest of the app (Map, customer cards, Home, overdue) reads.
import { pool } from "./db/pool.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./routes/customers.js";
import { batchExpandAreas } from "./routes/visitPlans.js";
import { planRep, pathKm, hasLocation } from "./routePlanner.js";

// Week is shown Monday-first; day_of_week stays 0 = Sunday .. 6 = Saturday.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_WEIGHT = { full: 1, half: 0.5 };
export const DEFAULT_DAYS = { 1: "full", 2: "full", 3: "full", 4: "full", 5: "full", 6: "half" };

export function parseDays(raw) {
  const src = raw && typeof raw === "object" ? raw : DEFAULT_DAYS;
  const days = [];
  for (const dow of WEEK_ORDER) {
    const kind = src[dow] ?? src[String(dow)];
    if (kind === "full" || kind === "half") days.push({ dow, kind, weight: DAY_WEIGHT[kind] });
  }
  return days;
}

export function parseFrequency(raw) {
  const days = Number(raw ?? 7);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}

// Every active field rep with the customers the planner may route: their own customers, minus the channels that are
// never visited (KF/CAS/CVO/PCO/OEM) and the office check-in place.
async function loadRepsWithCustomers(db) {
  const { rows: reps } = await db.query("SELECT id, name, position FROM users WHERE role = 'sales_manager' ORDER BY name");
  const { rows: customers } = await db.query(
    `SELECT c.id, c.name, c.lat, c.lng, c.region, c.subregion, c.assigned_manager_id, c.visit_frequency_days
       FROM customers c
      WHERE c.assigned_manager_id IS NOT NULL AND ${NOT_NO_VISIT_CHANNEL_SQL}
      ORDER BY c.id`
  );
  const byRep = new Map(reps.map((r) => [r.id, []]));
  for (const c of customers) byRep.get(c.assigned_manager_id)?.push(c);
  return { reps, byRep };
}

async function insertRules(db, setId, userId, daysMap) {
  // empty days are stored too: a rep with a row in the set is "covered" by it, even with nothing on some day
  for (const [dow, ids] of daysMap) {
    await db.query("INSERT INTO route_plan_set_rules (set_id, user_id, day_of_week, customer_ids) VALUES ($1, $2, $3, $4)", [setId, userId, dow, ids]);
  }
}

// New automatic set: every rep's own customers spread over the chosen working days, all at one visit frequency.
export async function createAutoSet({ name, frequencyDays, days, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { reps, byRep } = await loadRepsWithCustomers(client);
    const params = { frequency_days: frequencyDays, days: Object.fromEntries(days.map((d) => [d.dow, d.kind])) };
    const { rows } = await client.query(
      "INSERT INTO route_plan_sets (name, kind, params, created_by) VALUES ($1, 'auto', $2, $3) RETURNING id",
      [name, JSON.stringify(params), createdBy]
    );
    const setId = rows[0].id;
    for (const rep of reps) {
      const mine = byRep.get(rep.id);
      if (!mine.length) continue;
      await insertRules(client, setId, rep.id, planRep(mine, days));
      await client.query(
        "INSERT INTO route_plan_set_frequencies (set_id, customer_id, days) SELECT $1::int, unnest($2::int[]), $3::int",
        [setId, mine.map((c) => c.id), frequencyDays]
      );
    }
    await client.query("COMMIT");
    return setId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The live plan (visit_plan_rules) as ordered id lists per rep and weekday. Area rules are expanded into the rep's
// own customers; customers reassigned to someone else are left out.
async function liveRulesByRep(db) {
  const { rows: rules } = await db.query("SELECT * FROM visit_plan_rules WHERE active ORDER BY user_id, day_of_week");
  const areaIds = await batchExpandAreas(rules);
  const { rows: assigned } = await db.query("SELECT id, assigned_manager_id FROM customers WHERE assigned_manager_id IS NOT NULL");
  const owner = new Map(assigned.map((r) => [r.id, r.assigned_manager_id]));
  const result = new Map();
  for (const rule of rules) {
    const ids = [...new Set([...(rule.customer_ids ?? []), ...(areaIds.get(rule.id) ?? [])])].filter((id) => owner.get(id) === rule.user_id);
    if (!ids.length) continue;
    if (!result.has(rule.user_id)) result.set(rule.user_id, new Map());
    result.get(rule.user_id).set(rule.day_of_week, ids);
  }
  return result;
}

// Copies the live plan and the current frequencies of the customers on it into a set (replacing the set's content).
async function fillSetFromLive(db, setId) {
  await db.query("DELETE FROM route_plan_set_rules WHERE set_id = $1", [setId]);
  await db.query("DELETE FROM route_plan_set_frequencies WHERE set_id = $1", [setId]);
  const live = await liveRulesByRep(db);
  const all = new Set();
  for (const [userId, daysMap] of live) {
    await insertRules(db, setId, userId, daysMap);
    for (const ids of daysMap.values()) ids.forEach((id) => all.add(id));
  }
  if (all.size) {
    await db.query(
      "INSERT INTO route_plan_set_frequencies (set_id, customer_id, days) SELECT $1, id, visit_frequency_days FROM customers WHERE id = ANY($2) AND visit_frequency_days BETWEEN 1 AND 365",
      [setId, [...all]]
    );
  }
  await db.query("UPDATE route_plan_sets SET updated_at = now() WHERE id = $1", [setId]);
  return all.size;
}

// "Save the current plan as a set".
export async function snapshotLive({ name, createdBy }) {
  const { rows } = await pool.query("INSERT INTO route_plan_sets (name, kind, created_by) VALUES ($1, 'snapshot', $2) RETURNING id", [name, createdBy]);
  await fillSetFromLive(pool, rows[0].id);
  return rows[0].id;
}

export async function duplicateSet(id, name, createdBy) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO route_plan_sets (name, kind, params, created_by) SELECT $2, CASE WHEN kind = 'snapshot' THEN 'manual' ELSE kind END, params, $3 FROM route_plan_sets WHERE id = $1 RETURNING id",
      [id, name, createdBy]
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const newId = rows[0].id;
    await client.query("INSERT INTO route_plan_set_rules SELECT $2::int, user_id, day_of_week, customer_ids FROM route_plan_set_rules WHERE set_id = $1", [id, newId]);
    await client.query("INSERT INTO route_plan_set_frequencies SELECT $2::int, customer_id, days FROM route_plan_set_frequencies WHERE set_id = $1", [id, newId]);
    await client.query("COMMIT");
    return newId;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Switching the active plan. The plan being left is first refreshed from the live rules (so edits made on the old
// Route Plans / Map screens are not lost); with no active set yet, the live plan is saved as "Previous plan".
export async function activateSet(id, actorId, previousName) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: target } = await client.query("SELECT id FROM route_plan_sets WHERE id = $1 FOR UPDATE", [id]);
    if (!target[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: active } = await client.query("SELECT id FROM route_plan_sets WHERE is_active");
    if (active[0]?.id === id) {
      await client.query("COMMIT");
      return true;
    }
    if (active[0]) {
      await fillSetFromLive(client, active[0].id);
      await client.query("UPDATE route_plan_sets SET is_active = false WHERE id = $1", [active[0].id]);
    } else {
      const { rows: live } = await client.query("SELECT 1 FROM visit_plan_rules WHERE active LIMIT 1");
      if (live[0]) {
        const { rows } = await client.query("INSERT INTO route_plan_sets (name, kind, created_by) VALUES ($1, 'snapshot', $2) RETURNING id", [previousName, actorId]);
        await fillSetFromLive(client, rows[0].id);
      }
    }
    // only the reps this plan covers are replaced; everyone else's live rules stay as they are
    await client.query("DELETE FROM visit_plan_rules WHERE user_id IN (SELECT DISTINCT user_id FROM route_plan_set_rules WHERE set_id = $1)", [id]);
    await client.query(
      `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active)
       SELECT user_id, day_of_week, '[]'::jsonb, customer_ids, $2, true FROM route_plan_set_rules WHERE set_id = $1 AND cardinality(customer_ids) > 0`,
      [id, actorId]
    );
    await client.query(
      "UPDATE customers c SET visit_frequency_days = f.days FROM route_plan_set_frequencies f WHERE f.set_id = $1 AND f.customer_id = c.id AND c.visit_frequency_days <> f.days",
      [id]
    );
    await client.query("UPDATE route_plan_sets SET is_active = true, activated_at = now() WHERE id = $1", [id]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listSets() {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, s.kind, s.params, s.is_active, s.activated_at, s.created_at, s.updated_at, u.name AS created_by_name,
            COALESCE((SELECT sum(cardinality(customer_ids)) FROM route_plan_set_rules WHERE set_id = s.id), 0)::int AS customer_count,
            (SELECT array_agg(DISTINCT days) FROM route_plan_set_frequencies WHERE set_id = s.id) AS frequencies
       FROM route_plan_sets s LEFT JOIN users u ON u.id = s.created_by
      ORDER BY s.is_active DESC, s.updated_at DESC`
  );
  return rows;
}

// A set with everything the editor shows: per rep, per weekday the ordered customers (+ approximate driving km),
// and the rep's customers that are on no day yet.
export async function getSet(id) {
  const { rows: setRows } = await pool.query("SELECT s.*, u.name AS created_by_name FROM route_plan_sets s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1", [id]);
  const set = setRows[0];
  if (!set) return null;
  const { reps, byRep } = await loadRepsWithCustomers(pool);
  const { rows: rules } = await pool.query("SELECT user_id, day_of_week, customer_ids FROM route_plan_set_rules WHERE set_id = $1", [id]);
  const { rows: freqRows } = await pool.query("SELECT customer_id, days FROM route_plan_set_frequencies WHERE set_id = $1", [id]);
  const freqOf = new Map(freqRows.map((r) => [r.customer_id, r.days]));
  const ruleIds = [...new Set(rules.flatMap((r) => r.customer_ids))];
  const { rows: custRows } = ruleIds.length
    ? await pool.query("SELECT id, name, lat, lng, region, subregion, assigned_manager_id FROM customers WHERE id = ANY($1)", [ruleIds])
    : { rows: [] };
  const customerById = new Map(custRows.map((c) => [c.id, c]));
  const rulesByRep = new Map();
  for (const r of rules) {
    if (!rulesByRep.has(r.user_id)) rulesByRep.set(r.user_id, new Map());
    rulesByRep.get(r.user_id).set(r.day_of_week, r.customer_ids);
  }
  const slim = (c) => ({ id: c.id, name: c.name, region: c.region, subregion: c.subregion, lat: c.lat, lng: c.lng, frequency_days: freqOf.get(c.id) ?? c.visit_frequency_days ?? null });
  const outReps = reps.map((rep) => {
    const mine = byRep.get(rep.id);
    const planned = new Set();
    const days = WEEK_ORDER.map((dow) => {
      const ids = rulesByRep.get(rep.id)?.get(dow) ?? [];
      const customers = ids.map((cid) => customerById.get(cid)).filter(Boolean);
      customers.forEach((c) => planned.add(c.id));
      const pts = customers.filter(hasLocation);
      return { day_of_week: dow, customers: customers.map(slim), km: Math.round(pathKm(pts) * 10) / 10 };
    });
    return {
      user_id: rep.id,
      user_name: rep.name,
      position: rep.position,
      days,
      unplanned: mine.filter((c) => !planned.has(c.id)).map(slim),
      customer_total: mine.length,
    };
  });
  return {
    id: set.id,
    name: set.name,
    kind: set.kind,
    params: set.params,
    is_active: set.is_active,
    activated_at: set.activated_at,
    created_by_name: set.created_by_name,
    updated_at: set.updated_at,
    reps: outReps.filter((r) => r.customer_total > 0 || r.days.some((d) => d.customers.length)),
  };
}

// Replaces one rep's weekdays in a set. days: { dow: [customer ids in visiting order] }. A customer appears on one day only.
export async function setRepDays(setId, userId, daysObj) {
  const seen = new Set();
  const map = new Map();
  for (const dow of WEEK_ORDER) {
    const raw = daysObj?.[dow] ?? daysObj?.[String(dow)];
    const ids = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && !seen.has(n) && seen.add(n)) : [];
    map.set(dow, ids);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM route_plan_set_rules WHERE set_id = $1 AND user_id = $2", [setId, userId]);
    await insertRules(client, setId, userId, map);
    // customers newly placed on a day take the set's frequency, so the set stays one coherent plan
    const { rows } = await client.query("SELECT params->>'frequency_days' AS f FROM route_plan_sets WHERE id = $1", [setId]);
    const uniform = parseFrequency(rows[0]?.f);
    if (uniform && seen.size) {
      await client.query(
        "INSERT INTO route_plan_set_frequencies (set_id, customer_id, days) SELECT $1::int, unnest($2::int[]), $3::int ON CONFLICT DO NOTHING",
        [setId, [...seen], uniform]
      );
    }
    await client.query("UPDATE route_plan_sets SET updated_at = now() WHERE id = $1", [setId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One visit frequency for every customer of the set at once.
export async function setSetFrequency(setId, days) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM route_plan_set_frequencies WHERE set_id = $1", [setId]);
    await client.query(
      "INSERT INTO route_plan_set_frequencies (set_id, customer_id, days) SELECT DISTINCT $1::int, unnest(customer_ids), $2::int FROM route_plan_set_rules WHERE set_id = $1::int",
      [setId, days]
    );
    await client.query("UPDATE route_plan_sets SET params = jsonb_set(params, '{frequency_days}', to_jsonb($2::int)), updated_at = now() WHERE id = $1", [setId, days]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
