// One-time setup of the cash desks (payments redesign, release 2): makes each desk (or turns the Excel account of that name into a desk)
// and adds its holders, found by name and role among the active people. Then every active sales rep without a desk gets his own.
// Safe to run again: holders are only added, never removed; a person not found (or found twice) is reported and skipped -- set them in
// the app (Money -> Bank & cash desks -> Cash desks).
//
//   docker compose exec -T app node scripts/setup-cash-desks.mjs '[{"desk":"Office desk","holders":[{"names":["Ani","Անի"],"role":"accountant"},{"role":"admin","all":true}]}]'
//
// The names come in the command (not in the code): people's names are not kept in the repository.
import { pool } from "../src/db/pool.js";
import { ensureAllRepDesks, listDesks, saveDesk } from "../src/money/payments2/desks.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const nameFits = (full, wanted) => {
  const f = norm(full);
  const w = norm(wanted);
  return Boolean(w) && (f === w || f.startsWith(`${w} `) || f.endsWith(` ${w}`) || f.includes(` ${w} `));
};

async function main() {
  let plan;
  try {
    plan = JSON.parse(process.argv[2] ?? "");
    if (!Array.isArray(plan)) throw new Error("not a list");
  } catch (err) {
    console.error(`Give the desks as a JSON list (${err.message})`);
    process.exit(1);
  }
  const { rows: people } = await pool.query("SELECT id, name, name_hy, role FROM users WHERE status = 'active' AND role <> 'customer'");
  const problems = [];
  for (const item of plan) {
    const deskName = String(item?.desk ?? "").trim();
    if (!deskName) continue;
    const ids = [];
    for (const h of item.holders ?? []) {
      const names = (h.names ?? []).filter(Boolean);
      // by name; the role only decides between two people with the same name (and finds the person when no name is given)
      // { "role": "admin", "all": true } = every active person with that role
      let found = names.length ? people.filter((p) => names.some((n) => nameFits(p.name, n) || nameFits(p.name_hy, n))) : people.filter((p) => p.role === h.role);
      if (found.length > 1 && h.role && found.some((p) => p.role === h.role)) found = found.filter((p) => p.role === h.role);
      const label = names[0] ?? h.role;
      if (h.all === true && !names.length && found.length) ids.push(...found.map((p) => p.id));
      else if (found.length === 1) ids.push(found[0].id);
      else problems.push(`${deskName}: ${label} -- ${found.length ? `${found.length} people fit (${found.map((p) => p.name).join(", ")})` : "nobody fits"}, set in the app`);
    }
    const current = (await listDesks()).find((d) => d.name.toLowerCase() === deskName.toLowerCase());
    const holderIds = [...new Set([...(current?.holders ?? []).map((u) => u.id), ...ids])];
    const r = current ? await saveDesk(pool, current.id, { holder_ids: holderIds, active: true }) : await saveDesk(pool, null, { name: deskName, holder_ids: holderIds });
    if (r.error) problems.push(`${deskName}: ${r.error}`);
  }
  const made = await ensureAllRepDesks();
  console.log("Cash desks:");
  for (const d of (await listDesks()).filter((x) => x.active)) console.log(`  ${d.name}: ${d.holders.map((u) => u.name).join(", ") || "(no holder)"}`);
  if (made) console.log(`New rep desks made: ${made}`);
  if (problems.length) {
    console.log("To set in the app:");
    for (const p of problems) console.log(`  ${p}`);
  } else console.log("OK");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
