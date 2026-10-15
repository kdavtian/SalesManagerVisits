// Vaghinak's two chasers beyond the field rules (owner, 2026-10-15; no mandatory customer fields were changed):
//  1. MISSING CUSTOMER DATA: reps get a small task (next visit) for customers with no phone or no region, three a day
//     at most, planned customers first; customers nobody owns (no manager / no channel) go to the sales director.
//     The tasks close themselves when the data is filled. In test (shadow) mode only a shadow message is written.
//  2. ORDERS WAITING TOO LONG at a step (confirm, pack): the person who holds the step gets a message; at twice the
//     limit it goes to the CEO and admins too. Limits are Vaghinak settings (slaConfirmH, slaPackH).
import { createMessage, plannedForDay } from "./engine.js";
import { durationHy } from "./phrases.js";
import { createOpsTask, usersWithRole } from "../opsTasks.js";
import { orderFlow } from "../opsReports.js";

const MAX_NEW_PER_REP_PER_DAY = 3;
const MAX_OPEN_PER_REP = 8;
const COOLDOWN_DAYS = 14;

const firstNames = (rows) => {
  const names = rows.slice(0, 2).map((r) => r.name);
  return `${names.join(", ")}${rows.length > 2 ? "…" : ""}`;
};

export async function dataChase({ db, day, settings, pick }) {
  // close what is fixed
  await db.query(
    `UPDATE tasks t SET status = 'done', completed_at = now(), completion_note = 'Տվյալները լրացվել են', updated_at = now()
     FROM customers c
     WHERE t.auto_kind = 'data_missing' AND t.status = 'open' AND t.customer_id = c.id AND COALESCE(c.phone, '') <> '' AND COALESCE(c.region, '') <> ''`
  );
  let created = 0;

  const { rows: candidates } = await db.query(
    `SELECT c.id, c.name, c.assigned_manager_id AS rep_id, (COALESCE(c.phone, '') = '') AS no_phone, (COALESCE(c.region, '') = '') AS no_region,
            u.name AS rep_name, u.name_hy, u.role, u.vaghinak_address,
            COALESCE((SELECT MAX(l.order_date) FROM erp_order_lines l WHERE l.erp_customer_id = c.erp_customer_id), DATE '2000-01-01') AS last_order
     FROM customers c
     JOIN users u ON u.id = c.assigned_manager_id AND u.role = 'sales_manager' AND u.vaghinak_muted_day IS DISTINCT FROM $1::date
     WHERE c.erp_customer_id IS NOT NULL AND c.erp_customer_id <> '10000' AND NOT COALESCE(c.checkin_for_all, false)
       AND (COALESCE(c.phone, '') = '' OR COALESCE(c.region, '') = '')
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.customer_id = c.id AND t.auto_kind = 'data_missing' AND (t.status = 'open' OR t.created_at > now() - ($2 || ' days')::interval))`,
    [day, COOLDOWN_DAYS]
  );
  const byRep = new Map();
  for (const c of candidates) (byRep.get(c.rep_id) ?? byRep.set(c.rep_id, []).get(c.rep_id)).push(c);
  const planned = await plannedForDay(db, [...byRep.keys()], day);
  for (const [repId, list] of byRep) {
    const plan = planned.get(repId) ?? new Set();
    list.sort((a, b) => (plan.has(b.id) ? 1 : 0) - (plan.has(a.id) ? 1 : 0) || String(b.last_order).localeCompare(String(a.last_order)) || a.name.localeCompare(b.name));
    const { rows: open } = await db.query("SELECT count(*)::int AS n FROM tasks WHERE assignee_id = $1 AND auto_kind = 'data_missing' AND status = 'open'", [repId]);
    const room = Math.min(MAX_NEW_PER_REP_PER_DAY, MAX_OPEN_PER_REP - open[0].n);
    if (room <= 0) continue;
    const picked = list.slice(0, room);
    const rep = { id: repId, name: list[0].rep_name, name_hy: list[0].name_hy, role: list[0].role, vaghinak_address: list[0].vaghinak_address };
    if (settings.mode === "live") {
      for (const c of picked) {
        const items = [c.no_phone ? "Հեռախոսահամար" : null, c.no_region ? "Տարածաշրջան (մարզ / շրջան)" : null].filter(Boolean);
        if (await createOpsTask({ kind: "data_missing", title: `Լրացրու հաճախորդի տվյալները՝ ${c.name}`, assigneeId: repId, customerId: c.id, dueIsNextVisit: true, items, notify: false, db })) created++;
      }
    }
    // one friendly message per rep per day (a shadow one in test mode)
    await createMessage(db, rep, { kind: "data_chase", level: 1, day, ctx: { n: picked.length, names: firstNames(picked) }, audience: "rep", settings, pick });
  }

  // customers nobody owns -> the sales director
  const { rows: unowned } = await db.query(
    `SELECT id, name FROM customers
     WHERE erp_customer_id IS NOT NULL AND erp_customer_id <> '10000' AND NOT COALESCE(checkin_for_all, false)
       AND (assigned_manager_id IS NULL OR COALESCE(sales_channel, '') = '') ORDER BY id DESC`
  );
  if (unowned.length) {
    const directors = await usersWithRole("sales_director", db);
    const { rows: dirRows } = directors.length ? await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE id = ANY($1)", [directors]) : { rows: [] };
    for (const d of dirRows) {
      if (settings.mode === "live") {
        if (await createOpsTask({ kind: "data_missing", title: `Նշանակիր պատասխանատու կամ ալիք՝ ${unowned.length} հաճախորդի համար`, assigneeId: d.id, items: unowned.slice(0, 8).map((c) => c.name), notify: false, db })) created++;
      }
      await createMessage(db, d, { kind: "data_chase_owner", level: 1, day, ctx: { n: unowned.length }, audience: "management", settings, pick });
    }
  }
  return created;
}

// Who holds the step -> a message; twice over the limit -> also the CEO and admins.
export async function orderChase({ db, day, settings, pick }) {
  const flow = await orderFlow(db, 7);
  let created = 0;
  const holders = {
    confirm: async () => {
      const ids = await usersWithRole("sales_director", db);
      return ids.length ? ids : [...(await usersWithRole("ceo", db)), ...(await usersWithRole("admin", db))];
    },
    pack: async () => {
      const ids = await usersWithRole("warehouse_manager", db);
      return ids.length ? ids : await usersWithRole("sales_director", db);
    },
  };
  const userRow = async (ids) => (ids.length ? (await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE id = ANY($1)", [ids])).rows : []);
  for (const step of ["confirm", "pack"]) {
    const over = flow.waiting.filter((w) => w.step === step && w.over_sla);
    if (!over.length) continue;
    const oldest = over[0];
    const ctx = { n: over.length, h: durationHy(Math.round(oldest.waiting_h * 60)), customer: oldest.customer_name };
    for (const u of await userRow(await holders[step]())) {
      if (await createMessage(db, u, { kind: `order_waiting_${step}`, level: 1, day, ctx, audience: "management", settings, pick })) created++;
    }
    const worst = over.filter((w) => w.waiting_h > 2 * flow.sla[step]);
    if (worst.length) {
      const escalate = await userRow([...(await usersWithRole("ceo", db)), ...(await usersWithRole("admin", db))]);
      for (const u of escalate) {
        if (await createMessage(db, u, { kind: "order_waiting_escalation", level: 1, day, ctx: { n: worst.length, h: durationHy(Math.round(worst[0].waiting_h * 60)) }, audience: "management", settings, pick })) created++;
      }
    }
  }
  return created;
}
