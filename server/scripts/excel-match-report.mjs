#!/usr/bin/env node
// Which delivered app orders and collected app payments Excel already holds (owner, 2026-10-27: "if the order is included, included, if no -
// no. Same for collected payments"). Runs the same matching the sync runs after every Excel push (erpAutoMatch.markAppRowsInExcel) and prints
// a short report of the last 60 days. The previous debt on a signed blank adds the rows "not in Excel yet" and trusts Excel for the rest.
//
// Usage (on the droplet):
//   docker compose exec -T app node scripts/excel-match-report.mjs          # report only, nothing is saved
//   docker compose exec -T app node scripts/excel-match-report.mjs --apply  # also saves the links now instead of at the next sync
import { pool } from "../src/db/pool.js";
import { markAppRowsInExcel } from "../src/erpAutoMatch.js";

const apply = process.argv.includes("--apply");
const DAYS = 60;
const GRACE = 14; // signedActs.EXCEL_GRACE_DAYS
const day = (col) => `((${col} AT TIME ZONE 'Asia/Yerevan')::date)`;
const amd = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const marked = await markAppRowsInExcel(client);
  const { rows: [lim] } = await client.query(
    `SELECT (SELECT MAX(order_date) FROM erp_order_lines)::text AS orders_to, (SELECT MAX(cashflow_date) FROM erp_cashflow_lines)::text AS payments_to`
  );
  const { rows: orders } = await client.query(
    `SELECT o.id, o.order_code, c.erp_customer_id, o.total_amd, o.erp_matched_order_id,
            ${day(`COALESCE((SELECT MAX(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered'), o.updated_at)`)}::text AS d
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'delivered' AND o.updated_at > now() - interval '${DAYS} days' ORDER BY d`
  );
  const { rows: pays } = await client.query(
    `SELECT p.id, p.erp_customer_id_snapshot AS erp_customer_id, p.amount_amd, p.status, p.erp_match_key, ${day("p.payment_date")}::text AS d
     FROM payments p WHERE p.status <> 'rejected' AND p.payment_date > now() - interval '${DAYS} days' ORDER BY d`
  );
  const cutoff = (to) => (to ? new Date(new Date(`${to}T00:00:00Z`).getTime() - GRACE * 86400000).toISOString().slice(0, 10) : null);
  const split = (list, matched, to) => {
    const from = cutoff(to);
    const inExcel = list.filter(matched);
    const rest = list.filter((r) => !matched(r));
    const notYet = rest.filter((r) => !from || r.d >= from);
    const old = rest.filter((r) => from && r.d < from);
    return { inExcel, notYet, old };
  };
  const o = split(orders, (r) => r.erp_matched_order_id, lim.orders_to);
  const p = split(pays, (r) => r.erp_match_key, lim.payments_to);
  const sum = (l, k) => amd(l.reduce((s, r) => s + Number(r[k]), 0));
  const line = (r, k) => `    ${r.d}  ${r.erp_customer_id ?? "no Excel code"}  ${amd(r[k])}${r.order_code ? `  ${r.order_code}` : `  payment #${r.id} (${r.status})`}`;

  console.log(`Excel newest records: orders ${lim.orders_to ?? "-"}, payments ${lim.payments_to ?? "-"}`);
  console.log(`Newly linked by this run: ${marked.orders} orders, ${marked.payments} payments${apply ? " (saved)" : " (not saved; add --apply)"}`);
  console.log(`\nDelivered app orders, last ${DAYS} days: ${orders.length}`);
  console.log(`  in Excel:                      ${o.inExcel.length} (${sum(o.inExcel, "total_amd")} AMD)`);
  console.log(`  not in Excel yet (added):      ${o.notYet.length} (${sum(o.notYet, "total_amd")} AMD)`);
  console.log(`  older, no Excel twin (CHECK):  ${o.old.length} (${sum(o.old, "total_amd")} AMD) -- different amount/date in Excel, or missing there`);
  o.old.slice(0, 20).forEach((r) => console.log(line(r, "total_amd")));
  console.log(`\nCollected app payments, last ${DAYS} days: ${pays.length}`);
  console.log(`  in Excel:                      ${p.inExcel.length} (${sum(p.inExcel, "amount_amd")} AMD)`);
  console.log(`  not in Excel yet (subtracted): ${p.notYet.length} (${sum(p.notYet, "amount_amd")} AMD)`);
  console.log(`  older, no Excel twin (CHECK):  ${p.old.length} (${sum(p.old, "amount_amd")} AMD)`);
  p.old.slice(0, 20).forEach((r) => console.log(line(r, "amount_amd")));
  await client.query(apply ? "COMMIT" : "ROLLBACK");
} catch (err) {
  await client.query("ROLLBACK");
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
