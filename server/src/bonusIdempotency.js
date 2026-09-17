// Shared idempotent-insert helper for the Bonuses module. Every table this
// phase writes inside a transaction (bonus_source_contributions,
// bonus_point_ledger) relies on a UNIQUE constraint to turn a retried
// ingestion into a no-op -- but a bare INSERT that hits that constraint
// aborts the whole enclosing transaction in Postgres (any further command on
// the same connection is rejected until ROLLBACK), so catching the error and
// just running a follow-up SELECT on the same client does not work. Wrapping
// the insert in its own SAVEPOINT and rolling back only that savepoint on a
// unique-violation keeps the rest of the transaction (the earning-unit
// update, the caller's own later inserts) intact.
const UNIQUE_VIOLATION = "23505";
let savepointCounter = 0;

export async function insertIdempotent(client, { insertSql, insertParams, conflictSelectSql, conflictSelectParams }) {
  const savepoint = `bonus_idem_${++savepointCounter}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const { rows } = await client.query(insertSql, insertParams);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { row: rows[0], alreadyExisted: false };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    const { rows } = await client.query(conflictSelectSql, conflictSelectParams);
    return { row: rows[0], alreadyExisted: true };
  }
}
