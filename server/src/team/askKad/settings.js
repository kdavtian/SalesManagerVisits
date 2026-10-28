// Ask KAD's App-configuration settings (On/Off + the monthly spending cap in USD) and the month's spend.
import { pool } from "../../db/pool.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

export async function getAskKadSettings(db = pool) {
  const { rows } = await db.query("SELECT ask_kad_enabled, ask_kad_monthly_cap_usd FROM app_settings WHERE id = 1");
  return { enabled: rows[0]?.ask_kad_enabled ?? true, capUsd: Number(rows[0]?.ask_kad_monthly_cap_usd ?? 20) };
}

export async function setAskKadEnabled(enabled, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO app_settings (id, ask_kad_enabled) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET ask_kad_enabled = EXCLUDED.ask_kad_enabled RETURNING ask_kad_enabled`,
    [enabled]
  );
  return rows[0].ask_kad_enabled;
}

export async function setAskKadMonthlyCapUsd(usd, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO app_settings (id, ask_kad_monthly_cap_usd) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET ask_kad_monthly_cap_usd = EXCLUDED.ask_kad_monthly_cap_usd RETURNING ask_kad_monthly_cap_usd`,
    [usd]
  );
  return Number(rows[0].ask_kad_monthly_cap_usd);
}

// What the month has cost so far (Yerevan calendar month), summed from the request log.
export async function monthSpendUsd(db = pool, today = yerevanToday()) {
  const { rows } = await db.query(
    "SELECT COALESCE(sum(cost_usd), 0) AS spent FROM ask_kad_log WHERE (created_at AT TIME ZONE 'Asia/Yerevan')::date >= $1::date",
    [`${today.slice(0, 7)}-01`]
  );
  return Number(rows[0].spent);
}
