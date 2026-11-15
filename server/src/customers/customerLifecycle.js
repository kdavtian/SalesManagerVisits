// A customer's life after it is created: what keeps it from being deleted.

// What keeps a customer from being deleted (the ON DELETE RESTRICT links): its payments, old and new (a voided new payment still
// counts: payments are voided, never deleted), and KAD OS accounts linked to it. Named with numbers so the admin knows what to clear.
export async function customerDeleteBlockers(db, customerId) {
  const { rows: [p] } = await db.query(
    `SELECT (SELECT count(*) FROM payments WHERE customer_id = $1)::int
          + (SELECT count(*) FROM customer_payments WHERE customer_id = $1)::int AS payments,
            COALESCE((SELECT sum(amount_amd) FROM payments WHERE customer_id = $1 AND status <> 'rejected'), 0)::float8
          + COALESCE((SELECT sum(amount_amd) FROM customer_payments WHERE customer_id = $1 AND voided_at IS NULL), 0)::float8 AS payments_amd`,
    [customerId]
  );
  const { rows: links } = await db.query(
    "SELECT u.id, u.name FROM partner_links pl JOIN users u ON u.id = pl.user_id WHERE pl.customer_id = $1 ORDER BY u.name",
    [customerId]
  );
  return { payments: p.payments, payments_amd: Math.round(p.payments_amd), kad_os_accounts: links.map((l) => l.name) };
}
