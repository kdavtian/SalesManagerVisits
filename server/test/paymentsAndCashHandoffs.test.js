// Pure payment/cash-handoff calculations and visibility decisions
// (server/src/routes/payments.js, server/src/routes/cashHandoffs.js).
import "dotenv/config"; // routes/payments.js and routes/cashHandoffs.js import db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { canSeePayment } from "../src/routes/payments.js";
import { summarize, checkOnBehalf, canSeeHandoff } from "../src/routes/cashHandoffs.js";

// --- canSeePayment --------------------------------------------------------

test("canSeePayment: a sales_manager only sees their own submissions", () => {
  const manager = { id: 1, role: "sales_manager" };
  assert.equal(canSeePayment(manager, { sales_manager_id: 1 }), true);
  assert.equal(canSeePayment(manager, { sales_manager_id: 2 }), false);
});

test("canSeePayment: every other role sees every payment", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant", "warehouse_manager", "delivery_manager"]) {
    assert.equal(canSeePayment({ id: 1, role }, { sales_manager_id: 999 }), true, role);
  }
});

// --- summarize (cash-handoff totals) --------------------------------------

test("summarize: totals and per-channel subtotals across rows", () => {
  const rows = [
    { sales_channel: "SM YVN", amount_amd: "10000" },
    { sales_channel: "SM YVN", amount_amd: "5000" },
    { sales_channel: "SM B2B", amount_amd: "2000" },
  ];
  const result = summarize(rows);
  assert.equal(result.total_amd, 17000);
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.by_channel.map((c) => [c.sales_channel, c.count, c.total_amd]),
    [
      ["SM B2B", 1, 2000],
      ["SM YVN", 2, 15000],
    ],
    "sorted alphabetically by channel"
  );
});

test("summarize: a null/missing sales_channel groups under the unassigned marker", () => {
  const result = summarize([{ sales_channel: null, amount_amd: "3000" }]);
  assert.equal(result.by_channel.length, 1);
  assert.equal(result.by_channel[0].sales_channel, "—");
  assert.equal(result.by_channel[0].total_amd, 3000);
});

test("summarize: an empty row set totals to zero, not an error", () => {
  const result = summarize([]);
  assert.equal(result.total_amd, 0);
  assert.equal(result.count, 0);
  assert.deepEqual(result.by_channel, []);
});

test("summarize: amount_amd is coerced from string (as it comes back from Postgres numeric columns)", () => {
  const result = summarize([{ sales_channel: "SM YVN", amount_amd: "1234.56" }]);
  assert.equal(result.total_amd, 1234.56);
});

// --- checkOnBehalf (handoff authorization) --------------------------------

test("checkOnBehalf: acting for yourself is always allowed, regardless of role", () => {
  const self = { id: 1, role: "sales_manager" };
  assert.equal(checkOnBehalf(self, self, self), null);
});

test("checkOnBehalf: a role without canSubmitHandoffForOthers cannot act for anyone else", () => {
  const actor = { id: 1, role: "sales_manager" };
  const sender = { id: 2, role: "sales_manager" };
  const recipient = { id: 1, role: "sales_manager" };
  assert.equal(checkOnBehalf(actor, sender, recipient), "Not allowed to submit a handoff for another user");
});

test("checkOnBehalf: on-behalf-of is only valid when the sender is a sales_manager", () => {
  const actor = { id: 1, role: "sales_director" };
  const sender = { id: 2, role: "sales_director" };
  const recipient = { id: 1, role: "sales_director" };
  assert.equal(checkOnBehalf(actor, sender, recipient), "A handoff can only be submitted on behalf of a sales manager");
});

test("checkOnBehalf: the actor must be the recipient (declaring into their own custody), unless admin", () => {
  const actor = { id: 1, role: "sales_director" };
  const sender = { id: 2, role: "sales_manager" };
  const otherRecipient = { id: 3, role: "sales_director" };
  assert.equal(checkOnBehalf(actor, sender, otherRecipient), "You can only declare a handoff into your own custody");
});

test("checkOnBehalf: admin can declare a handoff into a third party's custody", () => {
  const actor = { id: 1, role: "admin" };
  const sender = { id: 2, role: "sales_manager" };
  const otherRecipient = { id: 3, role: "sales_director" };
  assert.equal(checkOnBehalf(actor, sender, otherRecipient), null);
});

test("checkOnBehalf: the valid first-hop case (director declaring a rep's collections into their own custody)", () => {
  const director = { id: 1, role: "sales_director" };
  const rep = { id: 2, role: "sales_manager" };
  assert.equal(checkOnBehalf(director, rep, director), null);
});

// --- canSeeHandoff ---------------------------------------------------------

test("canSeeHandoff: every non-sales_manager role sees every handoff", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant", "warehouse_manager", "delivery_manager"]) {
    assert.equal(canSeeHandoff({ id: 1, role }, { from_user_id: 99, to_user_id: 98, submitted_by: 97 }), true, role);
  }
});

test("canSeeHandoff: a sales_manager sees it only if they're a party to it", () => {
  const manager = { id: 1, role: "sales_manager" };
  assert.equal(canSeeHandoff(manager, { from_user_id: 1, to_user_id: 2, submitted_by: 2 }), true, "sender");
  assert.equal(canSeeHandoff(manager, { from_user_id: 2, to_user_id: 1, submitted_by: 2 }), true, "recipient");
  assert.equal(canSeeHandoff(manager, { from_user_id: 2, to_user_id: 3, submitted_by: 1 }), true, "submitter");
  assert.equal(canSeeHandoff(manager, { from_user_id: 2, to_user_id: 3, submitted_by: 4 }), false, "uninvolved");
});
