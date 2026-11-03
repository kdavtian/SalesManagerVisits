// The Pivot report's saved setups (table pivot_views, migration 179): private to the person who saved them unless shared with the
// other admin / CEO users. The route (routes/pivot.js) checks who may change one; these are only the queries.
const COLS = "v.id, v.name, v.owner_id, u.name AS owner_name, v.config, v.shared, v.created_at, v.updated_at";
const one = async (db, id) => (await db.query(`SELECT ${COLS} FROM pivot_views v LEFT JOIN users u ON u.id = v.owner_id WHERE v.id = $1`, [id])).rows[0];

// the person's own views and every shared one, by name
export async function listViews(db, userId) {
  const { rows } = await db.query(`SELECT ${COLS} FROM pivot_views v LEFT JOIN users u ON u.id = v.owner_id WHERE v.owner_id = $1 OR v.shared ORDER BY lower(v.name)`, [userId]);
  return rows;
}

export async function createView(db, { name, ownerId, config, shared }) {
  const { rows } = await db.query("INSERT INTO pivot_views (name, owner_id, config, shared) VALUES ($1, $2, $3, $4) RETURNING id", [name, ownerId, config, shared]);
  return one(db, rows[0].id);
}

export async function viewOwner(db, id) {
  return (await db.query("SELECT id, owner_id FROM pivot_views WHERE id = $1", [id])).rows[0] ?? null;
}

// changes: any of { name, config, shared }
export async function updateView(db, id, changes) {
  const sets = [];
  const params = [id];
  for (const col of ["name", "config", "shared"]) {
    if (changes[col] === undefined) continue;
    params.push(changes[col]);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) await db.query(`UPDATE pivot_views SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  return one(db, id);
}

// returns what was deleted, so the screen can put it back (undo)
export async function deleteView(db, id) {
  return (await db.query("DELETE FROM pivot_views WHERE id = $1 RETURNING name, config, shared", [id])).rows[0] ?? null;
}
