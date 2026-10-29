// The server's copy of the Excel cashflow (payment) lines, the same idea as the order lines' copy (debtAging.js): every customer's
// lines newest first, read again only when erp_cashflow_lines changed (its version in data_versions, migration 171). The debt screens
// ask "the last payment" and "the payments of the last weeks" for thousands of customers on every load (owner, 2026-10-30: "use the
// same memory for the Excel payments, to speed up the debt screens further").
let copy = null; // { version, map: Map(erpId -> [{ date: "YYYY-MM-DD", amount }]) }
let loading = null; // { version, promise }

async function cashflowVersion(db) {
  const { rows } = await db.query("SELECT version FROM data_versions WHERE table_name = 'erp_cashflow_lines'");
  return rows[0] ? String(rows[0].version) : null;
}

// Map(erpId -> lines newest first; the same order as `ORDER BY cashflow_date DESC, id DESC`), or null when the version is not
// recorded (the migration has not run): the caller then reads the table as before.
export async function cashflowByCustomer(db) {
  const version = await cashflowVersion(db);
  if (!version) return null;
  if (copy?.version === version) return copy.map;
  if (loading?.version !== version) {
    const promise = db
      .query("SELECT erp_customer_id, to_char(cashflow_date, 'YYYY-MM-DD') AS date, amount_amd FROM erp_cashflow_lines ORDER BY erp_customer_id, cashflow_date DESC, id DESC")
      .then(({ rows }) => {
        const map = new Map();
        for (const r of rows) {
          if (!map.has(r.erp_customer_id)) map.set(r.erp_customer_id, []);
          map.get(r.erp_customer_id).push({ date: r.date, amount: Number(r.amount_amd) });
        }
        copy = { version, map };
        return map;
      })
      .finally(() => {
        if (loading?.promise === promise) loading = null;
      });
    loading = { version, promise };
  }
  return loading.promise;
}

// The newest payment (a positive line) of the customer on or before `asOf` (YYYY-MM-DD, or null = any date): { date, amount } or null.
export function lastPayment(lines, asOf = null) {
  for (const l of lines ?? []) if (l.amount > 0 && (!asOf || l.date <= asOf)) return l;
  return null;
}
