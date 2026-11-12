// Sales directions (owner, 2026-11-12: "let me add a new sales direction on the admin panel"). One place to create a direction and set its
// rules (migration 204); every screen and rule reads them from here (GET), so a new direction needs no code change.
//   GET    /api/sales-channels        every signed-in user (the dropdowns, the map, the cost model)
//   POST   /api/sales-channels        admin: a new direction
//   PATCH  /api/sales-channels/:id    admin: name, order, active, manager, owner, rules (the code never changes: the Excel and every customer
//                                     carry it -- a wrong code is fixed by making the right direction and deactivating this one)
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { ownsSalesChannels } from "../../shared/roles.js";
import { refreshChannelRules, RULE_COLUMNS, VISIT_MODES, DEBT_MODES, COMMISSION_KINDS, VISIT_TYPE_KEYS, RESERVED_CODES } from "../../shared/salesChannelRules.js";

export const salesChannelsRouter = Router();
salesChannelsRouter.use(requireAuth);

const COLUMNS = `c.id, c.code, c.name, c.active, c.manager_user_id, u.name AS manager_name, u.status AS manager_status, c.owner_role, c.display_order,
  ${RULE_COLUMNS.map((k) => `c.${k}`).join(", ")},
  (SELECT count(*)::int FROM customers cu WHERE cu.sales_channel = c.code) AS customer_count`;

async function listChannels(db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM sales_channels c LEFT JOIN users u ON u.id = c.manager_user_id ORDER BY c.display_order, c.code`);
  return rows;
}

salesChannelsRouter.get("/", async (req, res) => {
  res.json(await listChannels());
});

class Invalid extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// The editable fields of a body, checked; `partial` = only those present (PATCH). Throws Invalid.
async function readFields(body, { partial }) {
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has("name")) {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 60) throw new Invalid("A name of 1-60 characters is required", "name_required");
    out.name = name;
  }
  if (has("active")) {
    if (typeof body.active !== "boolean") throw new Invalid("active must be true or false");
    out.active = body.active;
  }
  if (has("display_order")) {
    const n = Number(body.display_order);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Invalid("display_order must be a whole number");
    out.display_order = n;
  }
  if (has("owner_role")) {
    if (!["sales_director", "accountant"].includes(body.owner_role)) throw new Invalid("owner_role must be sales_director or accountant");
    out.owner_role = body.owner_role;
  }
  if (has("manager_user_id")) {
    if (body.manager_user_id === null) out.manager_user_id = null;
    else {
      const id = Number(body.manager_user_id);
      if (!Number.isInteger(id)) throw new Invalid("manager_user_id must be a user id or null");
      // only an active person who can own a direction (a rep, the sales director, the accountant)
      const { rows } = await pool.query("SELECT role, status FROM users WHERE id = $1", [id]);
      if (!rows[0] || rows[0].status !== "active" || !ownsSalesChannels(rows[0].role)) throw new Invalid("The manager must be an active sales manager, sales director or accountant", "manager_invalid");
      out.manager_user_id = id;
    }
  }
  const enums = { visit_mode: VISIT_MODES, debt_mode: DEBT_MODES, commission_kind: COMMISSION_KINDS, visit_type_key: VISIT_TYPE_KEYS };
  for (const [k, allowed] of Object.entries(enums)) {
    if (has(k)) {
      if (!allowed.includes(body[k])) throw new Invalid(`${k} must be one of ${allowed.join(", ")}`);
      out[k] = body[k];
    }
  }
  for (const k of ["separate_plan", "route_autofill", "director_report_excluded"]) {
    if (has(k)) {
      if (typeof body[k] !== "boolean") throw new Invalid(`${k} must be true or false`);
      out[k] = body[k];
    }
  }
  if (has("cash_source")) {
    const v = body.cash_source === null ? "" : String(body.cash_source).trim();
    if (v.length > 40) throw new Invalid("cash_source is at most 40 characters");
    out.cash_source = v || null;
  }
  return out;
}

const sendInvalid = (res, err) => res.status(400).json({ error: err.message, code: err.code });

salesChannelsRouter.post("/", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const code = String(body.code ?? "").trim().replace(/\s+/g, " ");
  // the code is how the Excel writes the direction ("Sales Rep" / "Assigned To"); letters, digits, spaces, - and _ only
  if (!code || code.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(code)) {
    return res.status(400).json({ error: "The code must be 1-40 letters, digits, spaces, - or _, exactly as in the Excel", code: "code_invalid" });
  }
  if (RESERVED_CODES.includes(code.toUpperCase())) return res.status(400).json({ error: "This code is reserved", code: "code_reserved" });
  let fields;
  try {
    fields = await readFields({ name: code, ...body }, { partial: true });
  } catch (err) {
    if (err instanceof Invalid) return sendInvalid(res, err);
    throw err;
  }
  const { rows: dup } = await pool.query("SELECT code FROM sales_channels WHERE lower(code) = lower($1)", [code]);
  if (dup[0]) return res.status(409).json({ error: `The direction "${dup[0].code}" already exists`, code: "code_exists" });
  if (fields.display_order === undefined) {
    const { rows } = await pool.query("SELECT COALESCE(max(display_order), 0) + 10 AS n FROM sales_channels");
    fields.display_order = rows[0].n;
  }
  const cols = ["code", ...Object.keys(fields)];
  const vals = [code, ...Object.values(fields)];
  const { rows } = await pool.query(
    `INSERT INTO sales_channels (${cols.join(", ")}, updated_at) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, now()) RETURNING id`,
    vals
  );
  await refreshChannelRules();
  const created = (await listChannels()).find((c) => c.id === rows[0].id);
  res.status(201).json(created);
});

salesChannelsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return res.status(404).json({ error: "Not found" });
  if (req.body?.code !== undefined) return res.status(400).json({ error: "The code of a direction cannot be changed", code: "code_locked" });
  let fields;
  try {
    fields = await readFields(req.body ?? {}, { partial: true });
  } catch (err) {
    if (err instanceof Invalid) return sendInvalid(res, err);
    throw err;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: "Nothing to change" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`);
    const { rows } = await client.query(`UPDATE sales_channels SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING code`, [id, ...Object.values(fields)]);
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }
    // a new "visit frequency type": the customers that follow the defaults get the new default at once (the trigger of migration 162)
    if (fields.visit_type_key !== undefined) {
      await client.query(
        `UPDATE customers SET visit_frequency_days = visit_frequency_days WHERE sales_channel = $1 AND NOT visit_frequency_manual`,
        [rows[0].code]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await refreshChannelRules();
  res.json((await listChannels()).find((c) => c.id === id));
});
