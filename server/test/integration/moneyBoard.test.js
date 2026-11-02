// The daily money board (payments redesign, release 4, owner 2026-11-02): collected / counted / received / bank, cash still in hands; who may
// read it; the bot's evening post goes out once (from 20:00 Yerevan), a failure is offered again.
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { moneyBoard, boardText, markBoardPosted } from "../../src/money/payments2/board.js";

const SYNC = { "x-e2e-rate-limit-bypass": "itest-bypass", "X-Sync-Key": "itest-sync-key" };
let rep, accountant, cookies, customer;
const today = () => pool.query("SELECT to_char((now() AT TIME ZONE 'Asia/Yerevan')::date, 'YYYY-MM-DD') AS d").then((r) => r.rows[0].d);

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager", { name: "ITest Board Rep" });
  accountant = await createUser("accountant");
  cookies = { rep: await loginAs(rep.email), accountant: await loginAs(accountant.email) };
  customer = await createCustomer({ created_by: rep.id });
});
test.after(async () => {
  await pool.query("DELETE FROM money_board_posts WHERE day >= CURRENT_DATE - 2");
  await cleanupAll();
  await stopTestServer();
});

test("the board counts the day's collections per rep and the cash still in the rep's hands; only admin / CEO / accountant read it", async () => {
  trackPayment(
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, 'x', 41000, now(), $2, 'Rep', 'pending', $2, $2) RETURNING id`,
      [customer.id, rep.id]
    )).rows[0].id
  );
  const day = await today();
  const b = await moneyBoard(pool, day);
  assert.ok(b.collected.by_rep.some((r) => r.name === "ITest Board Rep" && r.amd >= 41000));
  assert.ok(b.in_hands.by_person.some((p) => p.name === "ITest Board Rep" && p.amd >= 41000));
  assert.match(boardText(b), /ITest Board Rep/);
  const api = await apiRequest("/api/payments2/board", { cookie: cookies.accountant });
  assert.equal(api.status, 200);
  assert.equal(api.data.day, day);
  assert.equal((await apiRequest("/api/payments2/board", { cookie: cookies.rep })).status, 403);
});

test("the bot's evening post: needs the sync key, goes out once a day, a failure is offered again", async () => {
  assert.equal((await apiRequest("/api/erp-sync/money-board/pending", { headers: { ...SYNC, "X-Sync-Key": "wrong" } })).status, 401);
  const pending = await apiRequest("/api/erp-sync/money-board/pending", { headers: SYNC });
  assert.equal(pending.status, 200);
  const { rows: [{ hour }] } = await pool.query("SELECT EXTRACT(HOUR FROM now() AT TIME ZONE 'Asia/Yerevan')::int AS hour");
  if (hour < 20) {
    assert.equal(pending.data.board, null, "not before 20:00");
  } else {
    assert.ok(pending.data.board.text.includes("Դրամական"));
  }
  // posting state works whatever the hour: a failure keeps it pending, a success closes the day
  const day = await today();
  await markBoardPosted(pool, day, false, "telegram down");
  const { rows: [afterFail] } = await pool.query("SELECT posted_at, attempts FROM money_board_posts WHERE day = $1", [day]);
  assert.equal(afterFail.posted_at, null);
  assert.equal((await apiRequest("/api/erp-sync/money-board/posted", { method: "POST", headers: SYNC, body: { day, ok: true } })).status, 200);
  const { rows: [done] } = await pool.query("SELECT posted_at, attempts FROM money_board_posts WHERE day = $1", [day]);
  assert.ok(done.posted_at);
  assert.equal(done.attempts, 2);
  assert.equal((await apiRequest("/api/erp-sync/money-board/pending", { headers: SYNC })).data.board, null, "once a day");
});
