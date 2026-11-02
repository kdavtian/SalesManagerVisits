// Cash desks (owner, 2026-11-02): a cash desk is a cash account (the Excel "Source": "Office desk", "SM YVN desk" ...) held by one or
// more people (the office desk: both accountants and the CEO). Cash a person collects or receives lands on the desk they hold.
// Admin adds and edits desks; every sales rep gets a desk of his own automatically ("SM <name> desk") when he is created or becomes a
// rep, so the money he collects always has a place. A renamed desk keeps its old name as an Excel alias: the Excel import still finds it.
import { pool } from "../../db/pool.js";

const REP_ROLE = "sales_manager";
const cleanName = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

/** Map userId -> the cash desk (account id) they hold; with several desks the first by sort order. */
export async function deskMap(db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (h.user_id) h.user_id, a.id FROM cash_desk_holders h JOIN cash_accounts a ON a.id = h.account_id
     WHERE a.kind = 'cash' AND a.active ORDER BY h.user_id, a.sort_order, a.id`
  );
  return new Map(rows.map((r) => [r.user_id, r.id]));
}

/** The desks, each with its holders and the cash on it that still waits to be handed over (collected / counted). */
export async function listDesks(db = pool) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.active, a.excel_aliases, a.auto_for_user_id,
            COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'role', u.role) ORDER BY u.name) FILTER (WHERE u.id IS NOT NULL), '[]') AS holders,
            (SELECT count(*)::int FROM customer_payments p WHERE p.account_id = a.id AND p.voided_at IS NULL AND p.cash_state IN ('collected', 'counted')) AS waiting_count,
            (SELECT COALESCE(sum(p.amount_amd), 0)::float8 FROM customer_payments p WHERE p.account_id = a.id AND p.voided_at IS NULL AND p.cash_state IN ('collected', 'counted')) AS waiting_amd
     FROM cash_accounts a LEFT JOIN cash_desk_holders h ON h.account_id = a.id LEFT JOIN users u ON u.id = h.user_id
     WHERE a.kind = 'cash'
     GROUP BY a.id ORDER BY a.active DESC, a.sort_order, lower(a.name)`
  );
  return rows;
}

/** Active reps who hold no active cash desk (the setup gives each one his own). */
export async function repsWithoutDesk(db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.name FROM users u
     WHERE u.role = $1 AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM cash_desk_holders h JOIN cash_accounts a ON a.id = h.account_id WHERE h.user_id = u.id AND a.kind = 'cash' AND a.active)
     ORDER BY u.name`,
    [REP_ROLE]
  );
  return rows;
}

// A name no other account uses, as a name or as an Excel alias ("SM Davit desk", then "SM Davit desk 2" ...).
async function freeName(db, wanted, exceptId = null) {
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? wanted : `${wanted} ${n}`;
    const { rows } = await db.query(
      "SELECT 1 FROM cash_accounts WHERE id <> $2 AND (lower(name) = lower($1) OR lower($1) = ANY(SELECT lower(x) FROM unnest(excel_aliases) x))",
      [name, exceptId ?? 0]
    );
    if (!rows.length) return name;
  }
  return `${wanted} ${Date.now()}`;
}

/**
 * The rep's own desk, made when he has none. Returns the desk id (or null for a person who is not an active rep).
 * A desk made for him before and switched off is switched back on rather than made again.
 */
export async function ensureRepDesk(db, userId) {
  const { rows: [u] } = await db.query("SELECT id, name, role, status FROM users WHERE id = $1", [userId]);
  if (!u || u.role !== REP_ROLE || u.status !== "active") return null;
  const { rows: held } = await db.query(
    "SELECT a.id FROM cash_desk_holders h JOIN cash_accounts a ON a.id = h.account_id WHERE h.user_id = $1 AND a.kind = 'cash' AND a.active LIMIT 1",
    [userId]
  );
  if (held.length) return held[0].id;
  const { rows: [old] } = await db.query("SELECT id FROM cash_accounts WHERE auto_for_user_id = $1 AND kind = 'cash' ORDER BY id LIMIT 1", [userId]);
  let deskId = old?.id;
  if (deskId) await db.query("UPDATE cash_accounts SET active = true WHERE id = $1", [deskId]);
  else {
    const name = await freeName(db, cleanName(`SM ${u.name} desk`));
    const { rows } = await db.query("INSERT INTO cash_accounts (name, kind, auto_for_user_id) VALUES ($1, 'cash', $2) RETURNING id", [name, userId]);
    deskId = rows[0].id;
  }
  await db.query("INSERT INTO cash_desk_holders (account_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [deskId, userId]);
  return deskId;
}

/** Every active rep without a desk gets his own. Returns the number made. */
export async function ensureAllRepDesks(db = pool) {
  let made = 0;
  for (const r of await repsWithoutDesk(db)) if (await ensureRepDesk(db, r.id)) made += 1;
  return made;
}

/**
 * Add (no id) or change a desk: { name, holder_ids, active }. Returns { desk } or { status, error }.
 * A rename keeps the old name as an Excel alias. Holders must be active people.
 */
export async function saveDesk(db, id, body) {
  const name = body.name === undefined ? undefined : cleanName(body.name);
  if (name !== undefined && name.length < 2) return { status: 400, error: "Write the desk name" };
  const holderIds = body.holder_ids === undefined ? undefined : [...new Set((Array.isArray(body.holder_ids) ? body.holder_ids : []).map(Number).filter(Number.isInteger))];
  if (holderIds) {
    const { rows } = holderIds.length ? await db.query("SELECT id FROM users WHERE id = ANY($1) AND status = 'active'", [holderIds]) : { rows: [] };
    if (rows.length !== holderIds.length) return { status: 400, error: "A holder must be an active person" };
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let desk;
    if (id) {
      const { rows: [cur] } = await client.query("SELECT * FROM cash_accounts WHERE id = $1 FOR UPDATE", [id]);
      if (!cur || cur.kind !== "cash") {
        await client.query("ROLLBACK");
        return { status: 404, error: "Desk not found" };
      }
      let aliases = cur.excel_aliases ?? [];
      if (name !== undefined && name.toLowerCase() !== cur.name.toLowerCase()) {
        if ((await freeName(client, name, id)) !== name) {
          await client.query("ROLLBACK");
          return { status: 409, error: "Another account already has this name" };
        }
        aliases = [...new Set([...aliases.filter((a) => a.toLowerCase() !== name.toLowerCase()), cur.name])];
      }
      ({ rows: [desk] } = await client.query(
        "UPDATE cash_accounts SET name = COALESCE($2, name), active = COALESCE($3, active), excel_aliases = $4 WHERE id = $1 RETURNING id",
        [id, name ?? null, typeof body.active === "boolean" ? body.active : null, aliases]
      ));
    } else {
      if (!name) {
        await client.query("ROLLBACK");
        return { status: 400, error: "Write the desk name" };
      }
      // An account with this name may already exist (the Excel brought it in as a bank account): it becomes the desk.
      const { rows: [same] } = await client.query("SELECT id, kind FROM cash_accounts WHERE lower(name) = lower($1)", [name]);
      if (same && same.kind === "cash") {
        await client.query("ROLLBACK");
        return { status: 409, error: "This desk already exists" };
      }
      if (same) ({ rows: [desk] } = await client.query("UPDATE cash_accounts SET kind = 'cash', active = true WHERE id = $1 RETURNING id", [same.id]));
      else {
        if ((await freeName(client, name)) !== name) {
          await client.query("ROLLBACK");
          return { status: 409, error: "Another account already has this name" };
        }
        ({ rows: [desk] } = await client.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id", [name]));
      }
    }
    if (holderIds) {
      await client.query("DELETE FROM cash_desk_holders WHERE account_id = $1 AND NOT (user_id = ANY($2))", [desk.id, holderIds]);
      for (const uid of holderIds) await client.query("INSERT INTO cash_desk_holders (account_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [desk.id, uid]);
    }
    await client.query("COMMIT");
    return { desk: (await listDesks(db)).find((d) => d.id === desk.id) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") return { status: 409, error: "Another account already has this name" };
    throw err;
  } finally {
    client.release();
  }
}
