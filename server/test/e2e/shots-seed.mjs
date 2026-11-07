// The fixed data of the screen pictures (shots.visual.mjs, run by scripts/shots-vs-main.mjs): the same rows, in the same order, on a
// freshly migrated database, so the ids, names, amounts and dates on every screen are the same on both sides of the comparison.
// Dates are counted back from SHOTS_NOW (today 11:00 in Yerevan, chosen once by the runner for both sides): the server's own "today"
// (this month's sales, overdue days ...) then agrees with the data on any day the check runs.
import pg from "pg";
import bcrypt from "bcryptjs";

export const SHOTS_PASSWORD = "ShotsPass123!";
export const SHOTS_USERS = { admin: "shots-admin@kadmotors.local", sales_manager: "shots-rep@kadmotors.local" };

export async function seedShots(databaseUrl, nowIso) {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const now = new Date(nowIso);
  const at = (daysAgo, hour = 11, minute = 0) => {
    const d = new Date(now.getTime() - daysAgo * 86400000);
    // hour/minute in Yerevan (UTC+4, no daylight saving)
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 4, minute)).toISOString();
  };
  const day = (daysAgo) => at(daysAgo).slice(0, 10);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  try {
    await db.query("BEGIN");
    // No background job runs on this database: a job firing in the middle of the run (a reminder, an automatic task, Vaghinak) would add
    // a badge or a row to one side of the comparison only. The scheduler only runs a job whose next_run_at has come.
    await db.query(`CREATE OR REPLACE FUNCTION shots_no_jobs() RETURNS trigger AS $$ BEGIN NEW.next_run_at := 'infinity'; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.query("CREATE TRIGGER shots_no_jobs BEFORE INSERT OR UPDATE ON background_jobs FOR EACH ROW EXECUTE FUNCTION shots_no_jobs()");
    await db.query("UPDATE background_jobs SET next_run_at = 'infinity'");

    const hash = await bcrypt.hash(SHOTS_PASSWORD, 4);
    const user = (email, name, nameHy, role) =>
      one("INSERT INTO users (email, password_hash, name, name_hy, role, phone, created_at) VALUES ($1,$2,$3,$4,$5,'+37491000000',$6) RETURNING *", [email, hash, name, nameHy, role, at(200)]);
    const admin = await user(SHOTS_USERS.admin, "Test Admin", "Թեստ Ադմին", "admin");
    const rep = await user(SHOTS_USERS.sales_manager, "Aram Sargsyan", "Արամ Սարգսյան", "sales_manager");
    const rep2 = await user("shots-rep2@kadmotors.local", "Lilit Hakobyan", "Լիլիթ Հակոբյան", "sales_manager");

    const products = [];
    const P = [
      ["Castrol EDGE 5W-30 4L", "Castrol", 21500, 18200, 17400, 16600, 140, 4],
      ["Castrol EDGE 5W-40 1L", "Castrol", 6200, 5300, 5000, 4800, 260, 1],
      ["Castrol MAGNATEC 10W-40 4L", "Castrol", 14800, 12500, 11900, 11400, 95, 4],
      ["Castrol GTX 15W-40 4L", "Castrol", 11200, 9500, 9100, 8700, 0, 4],
      ["Castrol Transmax ATF 1L", "Castrol", 5400, 4600, 4400, 4200, 72, 1],
      ["Castrol Vecton 15W-40 20L", "Castrol", 58000, 49500, 47200, 45000, 18, 20],
      ["Mobil Super 3000 5W-40 4L", "Mobil", 16900, 14400, 13700, 13100, 40, 4],
      ["Mobil Delvac 15W-40 20L", "Mobil", 54000, 46000, 44000, 42000, 9, 20],
    ];
    for (const [i, [name, brand, retail, bronze, silver, gold, stock, size]] of P.entries()) {
      products.push(await one(
        `INSERT INTO products (name, sku, brand, unit, unit_price_amd, retail_price_amd, bronze_price_amd, silver_price_amd, gold_price_amd, stock_qty, size_l,
                               erp_product_id, active, created_at, updated_at)
         VALUES ($1,$2,$3,'pcs',$4,$4,$5,$6,$7,$8,$9,$10,true,$11,$11) RETURNING *`,
        [name, `SKU-${100 + i}`, brand, retail, bronze, silver, gold, stock, size, `P${1000 + i}`, at(100)]
      ));
    }

    const customers = [];
    const C = [
      ["Ավտոսերվիս Արարատ", "service", "gold", "Kentron", 40.1811, 44.5136, rep, 1250000, 12],
      ["Մոտոր Լյուքս", "retail", "silver", "Arabkir", 40.2052, 44.4987, rep, 380000, 48],
      ["Շինարար ՍՊԸ", "industrial", "bronze", "Shengavit", 40.1552, 44.4855, rep, 0, 0],
      ["Կարս Ավտո", "retail", "potential", "Malatia", 40.1702, 44.4512, rep, 0, 0],
      ["Ագրո Տրանս", "fleet", "silver", "Erebuni", 40.1401, 44.5302, rep2, 92000, 75],
      ["Յուղերի Տուն", "retail", "bronze", "Nor Nork", 40.1955, 44.5602, rep2, 15000, 5],
    ];
    for (const [i, [name, channel, tier, region, lat, lng, owner, debt, days]] of C.entries()) {
      const erp = `C${2000 + i}`;
      const c = await one(
        `INSERT INTO customers (name, sales_channel, customer_tier, region, lat, lng, created_by, assigned_manager_id, erp_customer_id, phone, address,
                                credit_limit_amd, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'+37410000000',$10,$11,$12) RETURNING *`,
        [name, channel, tier, region, lat, lng, owner.id, owner.id, erp, `${region} 1`, tier === "potential" ? null : 2000000, at(150)]
      );
      customers.push(c);
      await db.query(
        `INSERT INTO erp_customer_data (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, customer_name, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [erp, owner.name, debt, debt ? day(days) : null, debt ? days : null, name, at(0, 8)]
      );
    }

    // orders: today's, this week's and last month's, in every common status
    const O = [
      [0, rep, 0, "submitted", [[0, 2], [1, 6]], "invoice"],
      [1, rep, 0, "confirmed", [[2, 3]], "cash"],
      [4, rep2, 1, "submitted", [[5, 1], [7, 1]], "invoice"],
      [0, rep, 2, "delivered", [[0, 4], [4, 10]], "invoice"],
      [2, rep, 5, "delivered", [[3, 5]], "cash"],
      [5, rep2, 9, "delivered", [[6, 2]], "invoice"],
      [1, rep, 32, "delivered", [[0, 10], [2, 4]], "invoice"],
    ];
    for (const [n, [ci, owner, daysAgo, status, lines, method]] of O.entries()) {
      const items = lines.map(([pi, q]) => ({ p: products[pi], q }));
      const total = items.reduce((s, { p, q }) => s + Number(p.unit_price_amd) * q, 0);
      const o = await one(
        `INSERT INTO orders (customer_id, user_id, status, total_amd, order_code, payment_method, payment_term_days, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [customers[ci].id, owner.id, status, total, `ORD-${String(n + 1).padStart(4, "0")}`, method, method === "invoice" ? 45 : null, at(daysAgo, 10 + n % 6, 15)]
      );
      for (const { p, q } of items) {
        await db.query(
          `INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, list_price_amd, quantity, line_total_amd)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
          [o.id, p.id, p.name, p.brand, p.unit_price_amd, q, Number(p.unit_price_amd) * q]
        );
      }
    }

    // visits (Activity, Home, the customer card)
    const V = [[0, rep, 0, 9, 40, "order_placed"], [1, rep, 0, 10, 20, "no_order"], [2, rep, 1, 12, 5, "order_placed"], [4, rep2, 1, 15, 30, "payment_collected"], [3, rep, 3, 11, 0, "no_order"]];
    for (const [ci, owner, daysAgo, h, m, outcome] of V) {
      const c = customers[ci];
      await db.query(
        `INSERT INTO checkins (customer_id, user_id, timestamp, created_at, lat, lng, distance_meters, within_range, note, outcome, outcomes, brands_found)
         VALUES ($1,$2,$3,$3,$4,$5,12,true,$6,$7,ARRAY[$7],ARRAY['Castrol'])`,
        [c.id, owner.id, at(daysAgo, h, m), c.lat, c.lng, outcome === "no_order" ? "Պահեստը լիքն է" : null, outcome]
      );
    }

    // payments: one waiting for approval, two approved
    const Y = [[0, rep, 150000, 0, "pending"], [1, rep, 80000, 2, "approved"], [4, rep2, 40000, 6, "approved"]];
    for (const [ci, owner, amount, daysAgo, status] of Y) {
      const c = customers[ci];
      await db.query(
        `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot,
                               sales_channel, status, created_by, current_holder_id, created_at, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6,$6,$5,$10,$11)`,
        [c.id, c.name, c.erp_customer_id, amount, at(daysAgo, 12), owner.id, owner.name, c.sales_channel, status,
         status === "approved" ? admin.id : null, status === "approved" ? at(daysAgo, 16) : null]
      );
    }
    await db.query("COMMIT");
    return { admin, rep, customers, products };
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}
