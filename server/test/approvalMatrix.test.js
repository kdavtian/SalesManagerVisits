// The approvals table (shared/roles.js APPROVALS, owner 2026-11-05): every rule that reads it agrees with it for every role, and the list of
// what only the CEO / admin decide is exactly the one given to the owner.
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/shared/roles.js";
import { canApproveDiscountRole } from "../src/orders/discountPolicy.js";

const RULES = {
  customerEdits: R.canReviewCustomerEdits,
  paymentReview: R.canReviewPayments,
  returns: R.canApproveReturns,
  countedPaymentVoid: R.canVoidCountedPayment,
  fuel: R.canManageFuel,
  routePlanSuggestions: R.canReviewRoutePlanSuggestions,
  cashDesks: R.canManageCashDesks,
  cashflowManagement: R.isCashflowManagement,
  appOrderPerks: R.canManageAppOrders,
  staffRules: R.canSetStaffRules,
  signedDocuments: R.canManageSignedDocuments,
  pivot: R.usesPivot,
  tasksAnyone: R.tasksAnyone,
  partnerDocuments: R.canManagePartnerDocuments,
};

test("every rule that reads the table agrees with it, for every role", () => {
  for (const [key, rule] of Object.entries(RULES)) {
    for (const role of R.ROLES) assert.equal(rule(role), R.APPROVALS[key].roles.includes(role), `${key} / ${role}`);
  }
  for (const key of Object.keys(R.APPROVALS)) for (const role of R.APPROVALS[key].roles) assert.ok(R.ROLES.includes(role), `${key} names an unknown role ${role}`);
});

test("the sales director approves anything on an order; the operations director only above net cost; nobody else", () => {
  for (const [belowCost, belowLanding] of [[false, false], [true, false], [false, true], [true, true]]) {
    for (const role of ["sales_director", "ceo", "admin"]) assert.equal(canApproveDiscountRole(role, belowCost, belowLanding), true, `${role} ${belowCost} ${belowLanding}`);
    assert.equal(canApproveDiscountRole("operations_director", belowCost, belowLanding), !belowCost && !belowLanding);
    for (const role of ["sales_manager", "accountant", "warehouse_manager", "delivery_manager"]) assert.equal(canApproveDiscountRole(role, belowCost, belowLanding), false);
  }
});

test("what only the CEO (and admin) decide: the list the owner was given", () => {
  assert.deepEqual(
    R.ceoOnlyApprovals().map((a) => a.key).sort(),
    ["appOrderPerks", "cashDesks", "cashflowManagement", "countedPaymentVoid", "fuel", "pivot", "routePlanSuggestions", "signedDocuments", "staffRules", "tasksAnyone"]
  );
  assert.equal(R.canReviewCustomerEdits("sales_director"), true);
});
