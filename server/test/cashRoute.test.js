// One route for cash (owner, 2026-11-23): who may approve a payment without its hand-over (money/cashRoute.js). Pure rule, every case.
import test from "node:test";
import assert from "node:assert/strict";
import { approvalBlock, approverTakesCash, NOT_HANDED_OVER, IN_HANDOVER } from "../src/money/cashRoute.js";

const withRep = { status: "pending", pending_handoff_id: null, created_by: 5, holder_role: "sales_manager" };
const user = (role, id = 1) => ({ id, role });

test("cash still with the rep: admin and the CEO may approve, the accountant and the operations director may not", () => {
  assert.equal(approvalBlock(withRep, user("admin")), null);
  assert.equal(approvalBlock(withRep, user("ceo")), null);
  assert.equal(approvalBlock(withRep, user("accountant")), NOT_HANDED_OVER);
  assert.equal(approvalBlock(withRep, user("operations_director")), NOT_HANDED_OVER);
  assert.equal(approvalBlock({ ...withRep, holder_role: "sales_director" }, user("accountant")), NOT_HANDED_OVER, "counted by the director is not at the office yet");
});

test("the accountant: her own entry always; anybody's when the switch is on", () => {
  assert.equal(approvalBlock({ ...withRep, created_by: 7 }, user("accountant", 7)), null);
  assert.equal(approvalBlock(withRep, user("accountant", 7), { accountantDirect: true }), null);
  assert.equal(approvalBlock(withRep, user("operations_director", 7), { accountantDirect: true }), NOT_HANDED_OVER, "the switch is the accountant's only");
});

test("cash with an accountant (the route ran): every reviewer may approve again after a reopen", () => {
  const atOffice = { ...withRep, holder_role: "accountant" };
  for (const role of ["admin", "ceo", "operations_director", "accountant"]) assert.equal(approvalBlock(atOffice, user(role)), null, role);
});

test("inside a hand-over nobody approves, admin and the CEO included; only a pending payment; only a reviewer", () => {
  for (const role of ["admin", "ceo", "accountant"]) assert.equal(approvalBlock({ ...withRep, pending_handoff_id: 3 }, user(role), { accountantDirect: true }), IN_HANDOVER, role);
  assert.match(approvalBlock({ ...withRep, status: "approved" }, user("admin")), /pending/);
  for (const role of ["sales_manager", "sales_director", "warehouse_manager", "delivery_manager"]) assert.match(approvalBlock(withRep, user(role)), /Not allowed/, role);
});

test("approving cash that is not at the office moves it to the approver; cash already with an accountant stays there", () => {
  assert.equal(approverTakesCash(withRep, user("ceo")), true);
  assert.equal(approverTakesCash(withRep, user("admin")), true);
  assert.equal(approverTakesCash(withRep, user("accountant")), true);
  assert.equal(approverTakesCash({ ...withRep, holder_role: "accountant" }, user("ceo")), false);
  assert.equal(approverTakesCash(withRep, user("operations_director")), false);
});
