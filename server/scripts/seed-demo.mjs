// Demo account with believable test data, for showing the app to someone.
//
//   node scripts/seed-demo.mjs            create (or refresh) the demo sales manager and his data
//   node scripts/seed-demo.mjs --remove   delete everything this script created
//
// On the droplet (inside the app container):
//   cd /opt/field-visits && docker compose exec app node scripts/seed-demo.mjs
//   (set DEMO_PASSWORD=... in front to choose the password; otherwise one is generated and printed once)
//
// What it makes: ONE user (role sales_manager, so the demo only ever sees its own customers -- no real company
// data is visible to the audience), 26 customers around Yerevan (gold/silver/bronze, potential, competitors,
// every category, visited today / overdue / never visited), check-ins, orders in several statuses (real active
// products from the price list when there are some), approved payments, open tasks, debt figures and this
// month's sales/plan. Everything is tagged so --remove finds it again: the user's e-mail ends in
// @kadmotors.demo, customers have an ERP id starting "DEMO-".
//
// Heads-up: management screens (admin, CEO, accountant) add the demo orders / payments / debt into their totals
// while the demo data exists. Run --remove after the demo.
import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "../src/db/pool.js";
import { formatOrderCode } from "../src/routes/orders.js";

const EMAIL = "demo.rep@kadmotors.demo";
const NAME = "Demo Sales Manager";
const NAME_HY = "Դեմո վաճառքի մենեջեր";
const CHANNEL = "SM YVN";
const ERP_PREFIX = "DEMO-";

// name, category, tier, lat, lng, subregion, daysSinceLastVisit (null = never), potential [level, reasons]
const CUSTOMERS = [
  ["Արարատ Ավտոսերվիս", "Ավտոսերվիս", "gold", 40.1872, 44.5152, "Kentron", 0],
  ["Կենտրոն Յուղման կետ", "Յուղման կետ", "gold", 40.1792, 44.5086, "Kentron", 3],
  ["Սասուն Ավտո", "Խանութ", "silver", 40.2054, 44.5231, "Arabkir", 0],
  ["Երևան Մոթորս", "Ավտոսերվիս", "silver", 40.1628, 44.4912, "Ajapnyak", 6],
  ["Մասիս Յուղ", "Յուղման կետ", "silver", 40.2131, 44.4963, "Davtashen", 21],
  ["Արաբկիր Լուբրիկանտ", "Խանութ", "silver", 40.2012, 44.5014, "Arabkir", 9],
  ["Շենգավիթ Ավտոպարտս", "Խանութ", "bronze", 40.1451, 44.4837, "Shengavit", 12],
  ["Նոր Նորք Սերվիս", "Ավտոսերվիս", "bronze", 40.1938, 44.5679, "Nor Nork", 2],
  ["Էրեբունի Յուղման կետ", "Յուղման կետ", "bronze", 40.1396, 44.5342, "Erebuni", 28],
  ["Մալաթիա Ավտո", "Ավտոսերվիս", "bronze", 40.1721, 44.4496, "Malatia-Sebastia", 5],
  ["Դավթաշեն Մոտոր Շոփ", "Խանութ", "bronze", 40.2254, 44.4867, "Davtashen", 16],
  ["Աջափնյակ Գարաժ", "Ավտոսերվիս", "bronze", 40.1703, 44.4602, "Ajapnyak", 8],
  ["Քանաքեռ Ավտոլվացում", "Այլ", "potential", 40.2003, 44.5316, "Kanaker-Zeytun", null, [3, ["active_interest", "gave_price_list"]]],
  ["Զեյթուն Ավտոսերվիս", "Ավտոսերվիս", "potential", 40.1909, 44.5438, "Kanaker-Zeytun", null, [4, ["ready_first_order", "introduced_products"]]],
  ["Ավան Յուղման կետ", "Յուղման կետ", "potential", 40.2196, 44.5481, "Avan", 4, [2, ["price_mismatch", "negotiating"]]],
  ["Քոչար Ավտոպարտս", "Խանութ", "potential", 40.1566, 44.5119, "Shengavit", null, [1, ["own_import"]]],
  ["Նորագավիթ Սերվիս", "Ավտոսերվիս", "potential", 40.1584, 44.5605, "Nork-Marash", 11, [3, ["high_potential", "gave_price_list"]]],
  ["Սարի Թաղ Ավտո", "Այլ", "potential", 40.2082, 44.4748, "Davtashen", null, [2, ["no_decision_maker"]]],
  ["Փարպի Յուղեր", "Խանութ", "potential", 40.1337, 44.4915, "Shengavit", 19, [2, ["competitor_loyal"]]],
  ["Մառի Ավտոսերվիս", "Ավտոսերվիս", "potential", 40.1812, 44.4709, "Ajapnyak", null, [4, ["active_interest", "ready_first_order"]]],
  ["Մրցակից — Գազպրոմ Յուղեր", "Խանութ", "competitor", 40.1757, 44.5231, "Kentron", null],
  ["Մրցակից — Լյուկ Ավտո", "Ավտոսերվիս", "competitor", 40.1985, 44.4821, "Arabkir", null],
  ["Բաղրամյան Ավտոկենտրոն", "Ավտոսերվիս", "silver", 40.1965, 44.5043, "Kentron", 13],
  ["Կոմիտաս Լուբ", "Յուղման կետ", "bronze", 40.2117, 44.5174, "Arabkir", 1],
  ["Գյուլբենկյան Շոփ", "Խանութ", "bronze", 40.1844, 44.4953, "Kentron", 17],
  ["Րաֆֆի Ավտո", "Ավտոսերվիս", "gold", 40.2243, 44.5127, "Arabkir", 7],
];
const VISIT_FREQUENCY_DAYS = 14;

const dayAgo = (n, hour = 11, minute = 20) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const dateOnly = (d) => d.toISOString().slice(0, 10);

async function removeDemo(client) {
  const { rows: users } = await client.query("SELECT id FROM users WHERE email LIKE '%@kadmotors.demo'");
  const userIds = users.map((u) => u.id);
  const { rows: customers } = await client.query("SELECT id FROM customers WHERE erp_customer_id LIKE $1 OR created_by = ANY($2::int[])", [`${ERP_PREFIX}%`, userIds]);
  const customerIds = customers.map((c) => c.id);
  const counts = {};
  const del = async (label, sql, params) => {
    const r = await client.query(sql, params);
    counts[label] = r.rowCount;
  };
  await del("order items", "DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = ANY($1::int[]))", [customerIds]);
  await del("orders", "DELETE FROM orders WHERE customer_id = ANY($1::int[])", [customerIds]);
  await del("payments", "DELETE FROM payments WHERE customer_id = ANY($1::int[])", [customerIds]);
  await del("tasks", "DELETE FROM tasks WHERE customer_id = ANY($1::int[]) OR assignee_id = ANY($2::int[]) OR creator_id = ANY($2::int[])", [customerIds, userIds]);
  await del("check-ins", "DELETE FROM checkins WHERE customer_id = ANY($1::int[])", [customerIds]);
  await del("invoice lines", "DELETE FROM erp_order_lines WHERE erp_customer_id LIKE $1", [`${ERP_PREFIX}%`]);
  await del("debt rows", "DELETE FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`${ERP_PREFIX}%`]);
  await del("sales rows", "DELETE FROM sales_performance WHERE rep_name = $1", [NAME]);
  await del("customers", "DELETE FROM customers WHERE id = ANY($1::int[])", [customerIds]);
  await del("users", "DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
  return counts;
}

async function createDemo(client, password) {
  const hash = await bcrypt.hash(password, 10);
  const { rows: [rep] } = await client.query(
    `INSERT INTO users (name, name_hy, email, password_hash, role, position, map_color, phone)
     VALUES ($1, $2, $3, $4, 'sales_manager', $5, '#2563eb', '+37491000000') RETURNING id`,
    [NAME, NAME_HY, EMAIL, hash, CHANNEL]
  );

  const created = [];
  for (const [i, c] of CUSTOMERS.entries()) {
    const [name, category, tier, lat, lng, subregion, daysSince, potential] = c;
    const isCompetitor = tier === "competitor";
    const erpId = isCompetitor ? null : `${ERP_PREFIX}${String(i + 1).padStart(3, "0")}`;
    const { rows: [row] } = await client.query(
      `INSERT INTO customers (name, category, phone, address, lat, lng, created_by, assigned_manager_id, visit_frequency_days,
         erp_customer_id, region, subregion, customer_tier, sales_channel, potential_level, potential_reasons, potential_updated_at, potential_updated_by,
         next_followup_date, expected_volume_l)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, 'Yerevan', $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [
        name, category, isCompetitor ? null : `+3749100${String(10 + i).padStart(2, "0")}${String(10 + i).padStart(2, "0")}`,
        `${subregion}, Yerevan`, lat, lng, rep.id, isCompetitor ? 45 : VISIT_FREQUENCY_DAYS, erpId, subregion, tier,
        isCompetitor ? null : CHANNEL,
        potential ? potential[0] : null, potential ? potential[1] : [], potential ? new Date() : null, potential ? rep.id : null,
        potential && potential[0] >= 3 ? dateOnly(dayAgo(-3)) : null, potential ? potential[0] * 40 : null,
      ]
    );
    created.push({ id: row.id, name, tier, erpId, lat, lng, daysSince, index: i });
  }

  // Visits: the last one per customer, plus an older one for the busier customers.
  let visits = 0;
  const addVisit = async (cust, daysAgo, note) => {
    const at = dayAgo(daysAgo, 9 + (cust.index % 8), (cust.index * 7) % 60);
    await client.query(
      `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, note, brands_found, outcomes, created_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $3, $10)`,
      [cust.id, rep.id, at, cust.lat + 0.00004, cust.lng + 0.00003, 12 + (cust.index % 20), note, ["Castrol", "Mobil"], null, new Date(at.getTime() + 18 * 60000)]
    );
    visits += 1;
  };
  const notes = ["Շնորհանդես՝ նոր ապրանքատեսակ", "Պատվեր է ձևակերպվել", "Սեփականատերը բացակայում էր, կվերադառնամ", "Գնացուցակ է տրամադրվել", "Վճարումը ստացվել է"];
  for (const cust of created) {
    if (cust.daysSince === null || cust.tier === "competitor") continue;
    await addVisit(cust, cust.daysSince, notes[cust.index % notes.length]);
    if (["gold", "silver"].includes(cust.tier)) await addVisit(cust, cust.daysSince + 13, notes[(cust.index + 2) % notes.length]);
  }

  // Orders from real active products when the price list has them.
  const { rows: products } = await client.query(
    `SELECT id, name, brand, unit_price_amd FROM products WHERE active AND unit_price_amd > 0 ORDER BY brand NULLS LAST, id LIMIT 40`
  );
  const fallbackProducts = [
    { id: null, name: "Castrol Magnatec 5W-30 4L", brand: "Castrol", unit_price_amd: 28500 },
    { id: null, name: "Castrol EDGE 5W-40 4L", brand: "Castrol", unit_price_amd: 36900 },
    { id: null, name: "Castrol GTX 10W-40 4L", brand: "Castrol", unit_price_amd: 21800 },
    { id: null, name: "Castrol Vecton 15W-40 20L", brand: "Castrol", unit_price_amd: 89000 },
  ];
  const pool4 = products.length >= 4 ? products.filter((_, i) => i % Math.max(1, Math.floor(products.length / 8)) === 0).slice(0, 8) : fallbackProducts;
  const orderPlan = [
    // customer index, days ago, status
    [0, 1, "delivered"], [0, 9, "delivered"], [1, 3, "confirmed"], [2, 0, "submitted"], [2, 11, "delivered"], [3, 6, "delivered"],
    [4, 22, "delivered"], [5, 9, "delivered"], [6, 12, "delivered"], [7, 2, "confirmed"], [9, 5, "delivered"], [22, 1, "submitted"],
    [24, 7, "delivered"], [0, 18, "delivered"], [11, 8, "delivered"],
  ];
  let ordersMade = 0;
  let sales = 0;
  for (const [n, [custIdx, daysAgo, status]] of orderPlan.entries()) {
    const cust = created[custIdx];
    const lines = [0, 1, 2].slice(0, 2 + ((n + 1) % 2)).map((k) => {
      const p = pool4[(n + k * 3) % pool4.length];
      const qty = 2 + ((n * 3 + k * 5) % 9);
      return { p, qty, total: Number(p.unit_price_amd) * qty };
    });
    const total = lines.reduce((a, l) => a + l.total, 0);
    const at = dayAgo(daysAgo, 12, 10 + n);
    const { rows: [order] } = await client.query(
      `INSERT INTO orders (customer_id, user_id, status, total_amd, note, created_at, updated_at, order_code, payment_method, order_source)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'cash', 'new') RETURNING id`,
      [cust.id, rep.id, status, total, null, at, formatOrderCode(at, 90 + (n % 9))]
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd, brand, list_price_amd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $4)`,
        [order.id, l.p.id, l.p.name, l.p.unit_price_amd, l.qty, l.total, l.p.brand ?? null]
      );
    }
    ordersMade += 1;
    if (status !== "submitted") sales += total;
  }

  // Approved payments.
  let collected = 0;
  const paymentPlan = [[0, 4, 180000], [2, 10, 95000], [3, 5, 140000], [5, 8, 60000], [0, 17, 220000], [9, 4, 75000]];
  for (const [custIdx, daysAgo, amount] of paymentPlan) {
    const cust = created[custIdx];
    const at = dayAgo(daysAgo, 15, 5);
    await client.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id,
         sales_manager_name_snapshot, sales_channel, note, status, created_by, approved_by, approved_at, current_holder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Demo', 'approved', $6, $6, $5, $6)`,
      [cust.id, cust.name, cust.erpId, amount, at, rep.id, NAME, CHANNEL]
    );
    collected += amount;
  }

  // Open tasks (one due soon, one overdue) + one done.
  const tasks = [
    ["Հավաքել պարտքը՝ Մասիս Յուղ", "collect_debt", 4, -1, "open"],
    ["Այցելել և գնացուցակ տալ՝ Քանաքեռ Ավտոլվացում", "visit_customer", 12, 1, "open"],
    ["Պատվեր ձևակերպել՝ Շենգավիթ Ավտոպարտս", "make_order", 6, 2, "open"],
    ["Զանգահարել՝ Զեյթուն Ավտոսերվիս", "call_customer", 13, 0, "open"],
    ["Ստուգել ապրանքատեսականին՝ Արաբկիր Լուբրիկանտ", "check_products", 5, -3, "done"],
  ];
  for (const [title, kind, custIdx, dueInDays, status] of tasks) {
    await client.query(
      `INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind, status, completed_at, completed_by, created_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, now() - interval '3 days')`,
      [title, rep.id, created[custIdx].id, dateOnly(dayAgo(-dueInDays)), kind, status, status === "done" ? new Date() : null, status === "done" ? rep.id : null]
    );
  }

  // Debt figures (as the Excel sync would bring them) for the customers that buy on credit.
  const debts = [[0, 420000, 12, "0-30"], [2, 185000, 34, "31-60"], [3, 96000, 8, "0-30"], [4, 310000, 71, "61-90"], [5, 52000, 20, "0-30"], [9, 138000, 45, "31-60"], [24, 265000, 15, "0-30"]];
  for (const [custIdx, debt, daysSincePay, bucket] of debts) {
    const cust = created[custIdx];
    await client.query(
      `INSERT INTO erp_customer_data (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, customer_name, balance0_amd, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, now())`,
      [cust.erpId, CHANNEL, debt, dateOnly(dayAgo(daysSincePay)), daysSincePay, bucket, cust.name]
    );
    // The unpaid invoices behind that debt (the aging view walks them newest to oldest): 60 % / 40 %, older the higher the bucket.
    const [ageA, ageB] = bucket === "0-30" ? [6, 18] : bucket === "31-60" ? [40, 70] : [95, 120];
    for (const [k, [share, age]] of [[0.4, ageA], [0.6, ageB]].entries()) {
      const when = dayAgo(age);
      await client.query(
        `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_name, qty, unit_price_amd, revenue_amd, sales_rep)
         VALUES ($1, $2, $3, 'Castrol (demo)', 1, $4, $4, $5)`,
        [cust.erpId, `${cust.erpId}-${k + 1}`, dateOnly(when), Math.round(debt * share), CHANNEL]
      );
    }
  }

  // This month's sales / collections / plan for the Home progress bars.
  const month = new Date();
  month.setDate(1);
  await client.query(
    `INSERT INTO sales_performance (rep_name, month, sales_amd, collected_amd, budget_amd, synced_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (rep_name, month) DO UPDATE SET sales_amd = $3, collected_amd = $4, budget_amd = $5`,
    [NAME, dateOnly(month), Math.round(sales), collected, 4200000]
  );

  return { customers: created.length, visits, orders: ordersMade, payments: paymentPlan.length, tasks: tasks.length };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const removed = await removeDemo(client);
    if (process.argv.includes("--remove")) {
      await client.query("COMMIT");
      console.log("Demo data removed:", removed);
      return;
    }
    const password = process.env.DEMO_PASSWORD ?? crypto.randomBytes(7).toString("base64url");
    const made = await createDemo(client, password);
    await client.query("COMMIT");
    console.log("Demo data created:", made);
    console.log(`Sign in with: ${EMAIL}`);
    console.log(process.env.DEMO_PASSWORD ? "Password: the one you set in DEMO_PASSWORD." : `Password (shown once): ${password}`);
    console.log("When the demo is over: node scripts/seed-demo.mjs --remove");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
