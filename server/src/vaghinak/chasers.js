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

// DOWNPAYMENT FOLLOW-UP (1.338.0): an order with a downpayment whose goods are already packed or delivered, while the
// customer has not paid that amount since the order was made (payments of the customer, not rejected, dated from the
// order day). The rep gets a message and a task, once a day, three times at most; management hears about orders
// delivered 3+ days ago with the downpayment still missing. The task closes itself when the money is in. In shadow mode
// only shadow messages are written and no reminder is counted.
const amdText = (n) => `${Math.round(n).toLocaleString("en-US")} դրամ`;

export async function downpaymentChase({ db, day, settings, pick, now = new Date() }) {
  const { rows } = await db.query(
    `SELECT o.id, o.customer_id, o.user_id AS rep_id, o.downpayment_amd::float8 AS down, o.downpayment_reminders, o.downpayment_reminded_on::text AS reminded_on,
            c.name AS customer_name, u.name, u.name_hy, u.role, u.vaghinak_address,
            COALESCE((SELECT sum(p.amount_amd) FROM payments p WHERE p.customer_id = o.customer_id AND p.status <> 'rejected'
                       AND p.payment_date >= o.created_at - interval '1 day'), 0)::float8 AS paid,
            COALESCE((SELECT MIN(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status IN ('packed_stock_out', 'delivered')), o.updated_at) AS since
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN users u ON u.id = o.user_id AND u.role = 'sales_manager' AND u.vaghinak_muted_day IS DISTINCT FROM $1::date
     WHERE o.downpayment_amd > 0 AND o.status IN ('packed_stock_out', 'delivered') AND o.created_at > now() - interval '60 days'`,
    [day]
  );
  const missing = rows.filter((o) => o.paid < o.down);
  // close the tasks whose customer has no missing downpayment any more
  await db.query(
    `UPDATE tasks SET status = 'done', completed_at = now(), completion_note = 'Կանխավճարը ստացվել է', updated_at = now()
     WHERE auto_kind = 'downpayment' AND status = 'open' AND NOT (customer_id = ANY($1::int[]))`,
    [[...new Set(missing.map((o) => o.customer_id))]]
  );
  let created = 0;
  const byRep = new Map();
  for (const o of missing) {
    if (o.downpayment_reminders >= 3 || o.reminded_on === day) continue;
    (byRep.get(o.rep_id) ?? byRep.set(o.rep_id, []).get(o.rep_id)).push(o);
  }
  for (const [repId, list] of byRep) {
    const rep = { id: repId, name: list[0].name, name_hy: list[0].name_hy, role: list[0].role, vaghinak_address: list[0].vaghinak_address };
    const total = list.reduce((s, o) => s + (o.down - o.paid), 0);
    if (settings.mode === "live") {
      for (const o of list) {
        await createOpsTask({ kind: "downpayment", title: `Կանխավճար՝ ${o.customer_name} (${amdText(o.down - o.paid)})`, assigneeId: repId, customerId: o.customer_id, notify: false, db });
        await db.query("UPDATE orders SET downpayment_reminders = downpayment_reminders + 1, downpayment_reminded_on = $2 WHERE id = $1", [o.id, day]);
      }
    }
    if (await createMessage(db, rep, { kind: "downpayment_due", level: 1, day, ctx: { names: firstNames(list.map((o) => ({ name: o.customer_name }))), amount: amdText(total) }, audience: "rep", settings, pick })) created++;
  }
  // delivered 3+ days ago and still no downpayment -> management
  const late = missing.filter((o) => now.getTime() - new Date(o.since).getTime() > 3 * 86400000);
  if (late.length) {
    const ids = [...(await usersWithRole("sales_director", db)), ...(await usersWithRole("ceo", db)), ...(await usersWithRole("admin", db))];
    const { rows: mgmt } = ids.length ? await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE id = ANY($1)", [ids]) : { rows: [] };
    const ctx = { n: late.length, amount: amdText(late.reduce((s, o) => s + (o.down - o.paid), 0)), customer: late[0].customer_name };
    for (const u of mgmt) if (await createMessage(db, u, { kind: "downpayment_overdue", level: 1, day, ctx, audience: "management", settings, pick })) created++;
  }
  return created;
}
