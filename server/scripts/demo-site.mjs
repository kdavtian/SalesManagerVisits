// The DEMO SITE: a second, completely separate copy of the app (own database, own containers, own secrets) filled with made-up data,
// so a visitor can be given a login with CEO permissions without ever touching the company's real database. See docs/demo-site.md.
//
//   node scripts/demo-site.mjs seed                      fill an EMPTY demo database (CEO + 3 sales reps + products + customers + history)
//   node scripts/demo-site.mjs add-user <name> [role]    another login for a visitor: <name>@kad.demo, role ceo by default, random password printed once
//   node scripts/demo-site.mjs remove-user <name>        delete that login
//   node scripts/demo-site.mjs list-users
//
// Safety: every command refuses to run unless DEMO_MODE=1 (set only in the demo compose file), and `seed` refuses a database that already
// holds any user whose e-mail does not end in @kad.demo -- so it can never be pointed at the real database by mistake.
import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.js";
import { ROLES } from "../src/roles.js";
import { formatOrderCode } from "../src/routes/orders.js";

const DOMAIN = "kad.demo";

if (process.env.DEMO_MODE !== "1") {
  console.error("Refusing to run: DEMO_MODE is not 1. This script only works inside the demo stack (deploy/demo.sh).");
  process.exit(2);
}

// ---------- deterministic randomness, so every demo looks the same ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261025);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const jitter = (v, spread) => v + (rnd() - 0.5) * spread;

const dayAgo = (n, hour = 11, minute = 20) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const dateOnly = (d) => d.toISOString().slice(0, 10);

// ---------- the cast ----------
const REPS = [
  { key: "aram", name: "Aram Sargsyan", hy: "Արամ Սարգսյան", channel: "SM YVN", color: "#2563eb", centre: [40.185, 44.51], spread: 0.09, sub: ["Kentron", "Arabkir", "Ajapnyak", "Nor Nork", "Shengavit"], region: "Yerevan" },
  { key: "artak", name: "Artak Hakobyan", hy: "Արտակ Հակոբյան", channel: "SM Davtashen", color: "#f97316", centre: [40.215, 44.49], spread: 0.05, sub: ["Davtashen", "Avan", "Kanaker-Zeytun", "Erebuni"], region: "Yerevan" },
  { key: "lilit", name: "Lilit Petrosyan", hy: "Լիլիթ Պետրոսյան", channel: "SM Shirak", color: "#9333ea", centre: [40.79, 43.845], spread: 0.04, sub: ["Gyumri"], region: "Shirak" },
];
const NAME_FIRST = ["Արարատ", "Սասուն", "Կենտրոն", "Երևան", "Մասիս", "Արաբկիր", "Շենգավիթ", "Նոր Նորք", "Էրեբունի", "Մալաթիա", "Դավթաշեն", "Աջափնյակ", "Քանաքեռ", "Զեյթուն", "Ավան", "Նորագավիթ", "Վարդանանք", "Շիրակ", "Գյումրի", "Լուսավոր", "Արծիվ", "Սևան", "Հրազդան", "Այգեստան", "Նաիրի", "Գառնի"];
const NAME_TYPE = {
  "Ավտոսերվիս": ["Ավտոսերվիս", "Սերվիս", "Գարաժ", "Ավտոկենտրոն"],
  "Յուղման կետ": ["Յուղման կետ", "Լուբ", "Օյլ Սերվիս", "Յուղ"],
  "Խանութ": ["Ավտոպարտս", "Շոփ", "Լուբրիկանտ", "Ավտո"],
  "Այլ": ["Ավտոլվացում", "Ավտոտեխսպասարկում"],
};
const CATEGORIES = ["Ավտոսերվիս", "Ավտոսերվիս", "Յուղման կետ", "Յուղման կետ", "Խանութ", "Խանութ", "Այլ"];
const POTENTIAL_REASON_SETS = [["active_interest", "gave_price_list"], ["ready_first_order", "introduced_products"], ["price_mismatch", "negotiating"], ["own_import"], ["competitor_loyal"], ["no_decision_maker"], ["high_potential", "gave_price_list"], ["small_volume"]];

const PRODUCTS = [
  // brand, name, family, size L, bronze, silver, gold, retail, landing cost, stock
  ["Castrol", "Castrol Magnatec 5W-30 A3/B4 4L", "Magnatec", 4, 24500, 23800, 23000, 29900, 17900, 240],
  ["Castrol", "Castrol Magnatec 5W-40 C3 4L", "Magnatec", 4, 25800, 25000, 24200, 31500, 18900, 180],
  ["Castrol", "Castrol EDGE 5W-30 LL 4L", "EDGE", 4, 34900, 33800, 32600, 42900, 25400, 160],
  ["Castrol", "Castrol EDGE 0W-40 4L", "EDGE", 4, 38900, 37700, 36400, 47900, 28300, 120],
  ["Castrol", "Castrol EDGE 5W-40 1L", "EDGE", 1, 9900, 9600, 9300, 12500, 7100, 420],
  ["Castrol", "Castrol GTX 10W-40 4L", "GTX", 4, 18900, 18300, 17700, 23500, 13600, 300],
  ["Castrol", "Castrol GTX 15W-40 5L", "GTX", 5, 21900, 21200, 20500, 27500, 15800, 260],
  ["Castrol", "Castrol Vecton 15W-40 20L", "Vecton", 20, 72000, 69800, 67500, 88000, 52500, 70],
  ["Castrol", "Castrol Vecton Long Drain 10W-40 20L", "Vecton", 20, 88500, 85800, 83000, 108000, 64400, 45],
  ["Castrol", "Castrol Transmax ATF Dex III 1L", "Transmax", 1, 7800, 7500, 7200, 9900, 5600, 350],
  ["Castrol", "Castrol Brake Fluid DOT 4 0.5L", "Brake", 0.5, 3200, 3100, 2950, 4200, 2300, 500],
  ["Castrol", "Castrol Power1 4T 10W-40 1L", "Moto", 1, 6900, 6700, 6400, 8900, 4900, 220],
  ["Royal", "Royal 5W-30 Synthetic 4L", "Royal", 4, 19900, 19300, 18700, 24900, 14300, 140],
  ["Royal", "Royal 10W-40 Semi-Synthetic 4L", "Royal", 4, 15900, 15400, 14900, 19900, 11400, 200],
  ["Lotos", "Lotos Quazar 5W-40 4L", "Lotos", 4, 17500, 17000, 16400, 22000, 12600, 150],
  ["Orlen", "Orlen Platinum Ultor 15W-40 20L", "Orlen", 20, 58000, 56200, 54300, 72000, 42000, 60],
];

// ---------- helpers ----------
const newPassword = () => crypto.randomBytes(7).toString("base64url");

async function insertUser(client, { name, hy, email, role, position = null, color = null, password }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await client.query(
    `INSERT INTO users (name, name_hy, email, password_hash, role, position, map_color, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '+37400000000') RETURNING id`,
    [name, hy ?? null, email, hash, role, position, color]
  );
  return rows[0].id;
}

// ---------- seed ----------
async function seed() {
  const client = await pool.connect();
  try {
    const { rows: foreign } = await client.query("SELECT count(*)::int AS n FROM users WHERE email NOT LIKE $1", [`%@${DOMAIN}`]);
    if (foreign[0].n > 0) throw new Error(`This database has ${foreign[0].n} user(s) that are not @${DOMAIN}. Refusing to seed: it does not look like the demo database.`);
    const { rows: existing } = await client.query("SELECT count(*)::int AS n FROM users");
    if (existing[0].n > 0) {
      console.log("The demo database already has users; nothing to do. (deploy/demo.sh reset starts it again from empty.)");
      return;
    }

    await client.query("BEGIN");
    const ceoPassword = process.env.DEMO_PASSWORD ?? newPassword();
    const ceoId = await insertUser(client, { name: "Demo CEO", hy: "Դեմո տնօրեն", email: `ceo@${DOMAIN}`, role: "ceo", password: ceoPassword });
    const repIds = [];
    for (const r of REPS) {
      repIds.push(await insertUser(client, { name: r.name, hy: r.hy, email: `${r.key}@${DOMAIN}`, role: "sales_manager", position: r.channel, color: r.color, password: newPassword() }));
    }

    // Products (made-up prices and costs).
    const productRows = [];
    for (const [brand, name, family, size, bronze, silver, gold, retail, landing, stock] of PRODUCTS) {
      const { rows } = await client.query(
        `INSERT INTO products (name, brand, family, unit, unit_price_amd, active, bronze_price_amd, silver_price_amd, gold_price_amd, retail_price_amd,
           stock_qty, size_l, landing_cost_amd, net_cost_amd, is_commercial)
         VALUES ($1, $2, $3, 'pcs', $4, true, $4, $5, $6, $7, $8, $9, $10, $11, true) RETURNING id, name, brand, unit_price_amd`,
        [name, brand, family, bronze, silver, gold, retail, stock, size, landing, Math.round(landing * 1.04)]
      );
      productRows.push(rows[0]);
    }

    // Customers: ~20 per rep, a handful of potential ones, a couple of competitors.
    const used = new Set();
    const customers = [];
    for (const [ri, rep] of REPS.entries()) {
      const count = ri === 2 ? 14 : 22;
      for (let i = 0; i < count; i++) {
        const potential = i % 5 === 4;
        const competitor = i === count - 1 && ri < 2;
        const category = pick(CATEGORIES);
        let name;
        do name = `${pick(NAME_FIRST)} ${pick(NAME_TYPE[category])}`;
        while (used.has(name) && used.size < 600 && (name += ` ${between(2, 9)}`) && used.has(name));
        used.add(name);
        const tier = competitor ? "competitor" : potential ? "potential" : pick(["bronze", "bronze", "bronze", "silver", "silver", "gold"]);
        const lat = jitter(rep.centre[0], rep.spread);
        const lng = jitter(rep.centre[1], rep.spread * 1.3);
        const sub = pick(rep.sub);
        const level = potential ? between(1, 4) : null;
        const idx = customers.length + 1;
        const erpId = competitor || potential ? null : `DM-${String(idx).padStart(3, "0")}`;
        const { rows } = await client.query(
          `INSERT INTO customers (name, category, phone, address, lat, lng, created_by, assigned_manager_id, visit_frequency_days, erp_customer_id,
             region, subregion, customer_tier, sales_channel, potential_level, potential_reasons, potential_updated_at, potential_updated_by,
             next_followup_date, expected_volume_l, credit_term_days, credit_limit_amd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING id`,
          [
            name, category, competitor ? null : `+3749${between(1000000, 9999999)}`, `${sub}, ${rep.region}`, lat, lng, repIds[ri],
            competitor ? 45 : pick([14, 14, 21, 30]), erpId, rep.region, sub, tier, competitor ? null : rep.channel,
            level, potential ? pick(POTENTIAL_REASON_SETS) : [], potential ? new Date() : null, potential ? repIds[ri] : null,
            level && level >= 3 ? dateOnly(dayAgo(-between(1, 6))) : null, level ? level * 40 : null,
            competitor || potential ? 45 : pick([14, 30, 45]), tier === "gold" ? 3000000 : tier === "silver" ? 1500000 : tier === "bronze" ? 600000 : null,
          ]
        );
        customers.push({ id: rows[0].id, name, tier, erpId, lat, lng, rep: ri, buys: !competitor && !potential });
      }
    }

    // Visits: each buying customer visited some days ago (some today, some overdue), potential ones partly never visited.
    let visits = 0;
    const notes = ["Շնորհանդես՝ նոր ապրանքատեսակ", "Պատվեր է ձևակերպվել", "Սեփականատերը բացակայում էր", "Գնացուցակ է տրամադրվել", "Վճարումը ստացվել է", "Ստուգվեց պահեստը"];
    const addVisit = async (c, daysAgo, hour) => {
      const at = dayAgo(daysAgo, hour, between(0, 55));
      await client.query(
        `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, note, brands_found, created_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $3, $9)`,
        [c.id, repIds[c.rep], at, c.lat + 0.00003, c.lng + 0.00002, between(5, 60), pick(notes), pick([["Castrol"], ["Castrol", "Mobil"], ["Castrol", "Shell"], ["Mobil"]]), new Date(at.getTime() + between(8, 30) * 60000)]
      );
      visits += 1;
    };
    for (const c of customers) {
      if (c.tier === "competitor") continue;
      const last = c.buys ? pick([0, 1, 2, 3, 5, 7, 9, 12, 16, 22, 28]) : pick([null, null, 4, 11, 18]);
      if (last === null) continue;
      await addVisit(c, last, between(9, 17));
      if (c.buys) for (const extra of [last + between(10, 16), last + between(24, 34)]) await addVisit(c, extra, between(9, 17));
    }

    // Orders: the buying customers order every 1-4 weeks; amounts from 2-3 lines.
    let orders = 0;
    const salesByRepMonth = new Map();
    const orderSeqByDay = new Map();
    for (const c of customers.filter((x) => x.buys)) {
      const n = c.tier === "gold" ? between(4, 6) : c.tier === "silver" ? between(3, 4) : between(1, 3);
      for (let k = 0; k < n; k++) {
        const daysAgo = Math.min(75, Math.floor(k * between(9, 20) + between(0, 6)));
        const status = daysAgo === 0 ? pick(["submitted", "confirmed"]) : daysAgo <= 3 ? pick(["submitted", "confirmed", "packed_stock_out", "delivered"]) : "delivered";
        const lines = Array.from({ length: between(2, 3) }, () => {
          const p = pick(productRows);
          const price = Math.round(Number(p.unit_price_amd) * (c.tier === "gold" ? 0.94 : c.tier === "silver" ? 0.97 : 1));
          const qty = between(1, p.name.includes("20L") ? 3 : 8);
          return { p, price, qty, total: price * qty };
        });
        const total = lines.reduce((a, l) => a + l.total, 0);
        const at = dayAgo(daysAgo, between(10, 17), between(0, 55));
        const dayKey = dateOnly(at);
        const seq = 40 + (orderSeqByDay.get(dayKey) ?? 0);
        orderSeqByDay.set(dayKey, (orderSeqByDay.get(dayKey) ?? 0) + 1);
        const { rows } = await client.query(
          `INSERT INTO orders (customer_id, user_id, status, total_amd, created_at, updated_at, order_code, payment_method, order_source)
           VALUES ($1, $2, $3, $4, $5, $5, $6, 'cash', $7) RETURNING id`,
          [c.id, repIds[c.rep], status, total, at, formatOrderCode(at, Math.min(seq, 99)), pick(["new", "usual", "repeat"])]
        );
        for (const l of lines) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd, brand, list_price_amd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [rows[0].id, l.p.id, l.p.name, l.price, l.qty, l.total, l.p.brand, l.p.unit_price_amd]
          );
        }
        orders += 1;
        if (status !== "submitted") {
          const key = `${c.rep}|${at.getFullYear()}-${at.getMonth()}`;
          salesByRepMonth.set(key, (salesByRepMonth.get(key) ?? 0) + total);
        }
        // Erp order line, so debt aging and customer history have invoices to work with.
        if (c.erpId && status === "delivered") {
          await client.query(
            `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_name, qty, unit_price_amd, revenue_amd, sales_rep)
             VALUES ($1, $2, $3, 'Castrol (demo)', 1, $4, $4, $5)`,
            [c.erpId, `DM-${rows[0].id}`, dateOnly(at), total, REPS[c.rep].channel]
          );
        }
      }
    }

    // Payments: approved for about two thirds of the buyers, a few still waiting for approval.
    let payments = 0;
    for (const c of customers.filter((x) => x.buys)) {
      if (rnd() < 0.35) continue;
      const pending = rnd() < 0.1;
      const at = dayAgo(between(pending ? 0 : 1, 40), 15, between(0, 55));
      await client.query(
        `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id,
           sales_manager_name_snapshot, sales_channel, note, status, created_by, approved_by, approved_at, current_holder_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Demo', $9, $6, $10, $11, $6)`,
        [c.id, c.name, c.erpId, between(30, 400) * 1000, at, repIds[c.rep], REPS[c.rep].name, REPS[c.rep].channel, pending ? "pending" : "approved", pending ? null : ceoId, pending ? null : at]
      );
      payments += 1;
    }

    // Debt (what the Excel sync would bring): about every third buyer owes something, with real unpaid invoices behind it.
    for (const c of customers.filter((x) => x.buys && x.erpId)) {
      if (rnd() < 0.62) continue;
      const debt = between(40, 520) * 1000;
      const bucket = pick(["0-30", "0-30", "31-60", "61-90"]);
      const ages = bucket === "0-30" ? [6, 18] : bucket === "31-60" ? [40, 70] : [95, 120];
      const lastPay = between(5, 80);
      await client.query(
        `INSERT INTO erp_customer_data (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, customer_name, balance0_amd, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, now())`,
        [c.erpId, REPS[c.rep].channel, debt, dateOnly(dayAgo(lastPay)), lastPay, bucket, c.name]
      );
      await client.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [c.erpId]);
      for (const [k, [share, age]] of [[0.4, ages[0]], [0.6, ages[1]]].entries()) {
        await client.query(
          `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_name, qty, unit_price_amd, revenue_amd, sales_rep)
           VALUES ($1, $2, $3, 'Castrol (demo)', 1, $4, $4, $5)`,
          [c.erpId, `${c.erpId}-D${k + 1}`, dateOnly(dayAgo(age)), Math.round(debt * share), REPS[c.rep].channel]
        );
      }
    }

    // Tasks for each rep.
    const taskKinds = [["collect_debt", "Հավաքել պարտքը"], ["visit_customer", "Այցելել և գնացուցակ տալ"], ["make_order", "Պատվեր ձևակերպել"], ["call_customer", "Զանգահարել"], ["check_products", "Ստուգել ապրանքատեսականին"]];
    for (const [ri] of REPS.entries()) {
      const mine = customers.filter((c) => c.rep === ri && c.tier !== "competitor");
      for (let k = 0; k < 4; k++) {
        const c = pick(mine);
        const [kind, label] = taskKinds[(k + ri) % taskKinds.length];
        await client.query(
          `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '2 days')`,
          [`${label}՝ ${c.name}`, ceoId, repIds[ri], c.id, dateOnly(dayAgo(between(-3, 2))), kind]
        );
      }
    }

    // Sales / collections per channel (the Excel sync keys them by channel code) and an approved plan for the last four months
    // (Home progress bars, Company dashboard, Team performance).
    const today = new Date();
    const { rows: channelRows } = await client.query("SELECT id, code FROM sales_channels WHERE code = ANY($1)", [REPS.map((r) => r.channel)]);
    const channelId = new Map(channelRows.map((r) => [r.code, r.id]));
    // Plan per channel: a little above what the rep really sells in a month, so the bars are neither empty nor way past 100 %.
    const planOf = REPS.map((_, ri) => {
      let total = 0;
      for (const [key, v] of salesByRepMonth) if (key.startsWith(`${ri}|`)) total += v;
      return Math.max(1000000, Math.round((total / 2.5) * 1.55 / 100000) * 100000);
    });
    for (let m = 0; m < 4; m++) {
      const month = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const { rows: [plan] } = await client.query(
        `INSERT INTO perf_plans (month, version, status, created_by, submitted_by, submitted_at, approved_by, approved_at)
         VALUES ($1::date, 1, 'approved', $2, $2, $1::timestamptz, $2, $1::timestamptz) RETURNING id`,
        [dateOnly(month), ceoId]
      );
      for (const [ri, rep] of REPS.entries()) {
        const real = salesByRepMonth.get(`${ri}|${month.getFullYear()}-${month.getMonth()}`) ?? 0;
        const sales = m === 0 ? real : Math.round(planOf[ri] * (0.72 + rnd() * 0.4));
        await client.query(
          `INSERT INTO sales_performance (rep_name, month, sales_amd, collected_amd, budget_amd, synced_at) VALUES ($1, $2, $3, $4, $5, now())`,
          [rep.channel, dateOnly(month), sales, Math.round(sales * (0.7 + rnd() * 0.25)), planOf[ri]]
        );
        await client.query(
          `INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd, collection_target_amd, new_customers_target) VALUES ($1, $2, $3, $4, $5)`,
          [plan.id, channelId.get(rep.channel), planOf[ri], Math.round(planOf[ri] * 0.85), between(2, 5)]
        );
      }
    }

    await client.query("COMMIT");
    console.log("Demo data created:", { users: 1 + REPS.length, products: productRows.length, customers: customers.length, visits, orders, payments });
    console.log(`CEO login: ceo@${DOMAIN}`);
    console.log(process.env.DEMO_PASSWORD ? "Password: the one in DEMO_PASSWORD." : `Password (shown once): ${ceoPassword}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- visitors' logins ----------
function cleanName(raw) {
  const name = String(raw ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!name) throw new Error("Give a short name (letters and digits), e.g. add-user gevorg");
  return name;
}

async function addUser(rawName, role = "ceo") {
  if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}". One of: ${ROLES.join(", ")}`);
  const name = cleanName(rawName);
  const email = `${name}@${DOMAIN}`;
  const password = process.env.DEMO_PASSWORD ?? newPassword();
  const { rows } = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (rows[0]) throw new Error(`${email} already exists. Remove it first (remove-user ${name}) to get a new password.`);
  await insertUser(pool, { name: `Demo ${name}`, hy: null, email, role, password });
  console.log(`Created ${role} login: ${email}`);
  console.log(process.env.DEMO_PASSWORD ? "Password: the one in DEMO_PASSWORD." : `Password (shown once): ${password}`);
}

async function removeUser(rawName) {
  const email = `${cleanName(rawName)}@${DOMAIN}`;
  if (["ceo", "aram", "artak", "lilit"].includes(email.split("@")[0])) throw new Error("That is one of the built-in demo users; they stay (deploy/demo.sh reset rebuilds everything).");
  const { rowCount } = await pool.query("DELETE FROM users WHERE email = $1", [email]);
  console.log(rowCount ? `Removed ${email}` : `${email} does not exist`);
}

async function listUsers() {
  const { rows } = await pool.query("SELECT email, role, last_seen_at FROM users ORDER BY id");
  for (const r of rows) console.log(`${r.email.padEnd(28)} ${r.role.padEnd(18)} ${r.last_seen_at ? `last seen ${r.last_seen_at.toISOString().slice(0, 16)}` : "never signed in"}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "seed") await seed();
  else if (command === "add-user") await addUser(args[0], args[1]);
  else if (command === "remove-user") await removeUser(args[0]);
  else if (command === "list-users") await listUsers();
  else {
    console.error("Usage: demo-site.mjs seed | add-user <name> [role] | remove-user <name> | list-users");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
