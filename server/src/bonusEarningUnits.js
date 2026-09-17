// bonus_earning_units (migrations/076_bonuses_schema.sql): the per
// employee/customer/activity/Armenia-calendar-day cap for strawberries,
// carrots, and apples. One unit per (user, customer, activity, local_date);
// confirmed_scaled never exceeds max_scaled regardless of how many source
// contributions point at it.

// Gets the unit for (userId, customerId, activity, localDate), creating it
// at 0/max_scaled=2 if this is the first contribution ever seen for that
// combination. ON CONFLICT DO NOTHING + a follow-up SELECT (rather than DO
// UPDATE ... RETURNING) so a concurrent insert from another ingestion call
// never races this one into returning a stale pre-update row.
export async function getOrCreateEarningUnit(client, { userId, customerId, activity, localDate }) {
  await client.query(
    `INSERT INTO bonus_earning_units (user_id, customer_id, activity, local_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, customer_id, activity, local_date) DO NOTHING`,
    [userId, customerId, activity, localDate]
  );
  const { rows } = await client.query(
    `SELECT * FROM bonus_earning_units WHERE user_id = $1 AND customer_id = $2 AND activity = $3 AND local_date = $4`,
    [userId, customerId, activity, localDate]
  );
  return rows[0];
}

// Locks the unit's row for the duration of the caller's transaction (via
// SELECT ... FOR UPDATE) so two concurrent contributions to the same
// employee/customer/activity/day can never both read "0 confirmed" and both
// credit a full unit -- the second one blocks until the first commits, then
// sees the updated confirmed_scaled and correctly finds no room left.
export async function getEarningUnitForUpdate(client, { userId, customerId, activity, localDate }) {
  await getOrCreateEarningUnit(client, { userId, customerId, activity, localDate });
  const { rows } = await client.query(
    `SELECT * FROM bonus_earning_units
     WHERE user_id = $1 AND customer_id = $2 AND activity = $3 AND local_date = $4
     FOR UPDATE`,
    [userId, customerId, activity, localDate]
  );
  return rows[0];
}

// Locks a unit by id (rather than by its natural key) -- what a reversal
// needs, since it starts from a bonus_source_contributions row that already
// knows earning_unit_id rather than the user/customer/activity/date tuple.
export async function lockEarningUnitById(client, unitId) {
  const { rows } = await client.query("SELECT * FROM bonus_earning_units WHERE id = $1 FOR UPDATE", [unitId]);
  return rows[0];
}

export async function addToEarningUnit(client, unitId, deltaScaled) {
  const { rows } = await client.query(
    `UPDATE bonus_earning_units SET confirmed_scaled = confirmed_scaled + $2, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [unitId, deltaScaled]
  );
  return rows[0];
}
