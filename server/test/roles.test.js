// Permission decisions (server/src/roles.js) -- every exported function is
// pure (role string(s) in, boolean/array out), so every one is tested
// directly against all 7 roles rather than only through the HTTP-level
// coverage in test/integration/rolePermissions.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLES,
  seesAllActivity,
  seesFinancialExports,
  canDeleteOrEditDirectly,
  canReassignCustomers,
  canEditOwnSalesChannel,
  canAssignErpCustomerId,
  canManageProducts,
  canViewTeamLocations,
  canPlanForOthers,
  canConfirmOrders,
  broadcastsLocation,
  isPerfCeo,
  canEditChannelPlan,
  canReviewPlan,
  canReviseApprovedPlan,
  canReopenPlanAsDraft,
  seesAllPerformance,
  canCloseMonth,
  canReviewPayments,
  canSubmitPaymentsForOthers,
  seesAllPayments,
  validHandoffRecipientRoles,
  isTerminalHandoffRole,
  canSubmitHandoffForOthers,
  canManageWarehouse,
  canPlanRoutes,
  canDeliverOrders,
  canMarkDeliveredWithoutRoute,
  isFulfillmentRole,
  canRecordOrders,
  seesUnrecordedBadge,
  PAYMENT_NOTIFY_ROLES,
  seesGeneratedReports,
  seesCustomerErpData,
  canManageBonusChallenges,
  canApproveBonusRewards,
  canRecordBonusPayouts,
} from "../src/roles.js";

const OTHER_ROLES = (role) => ROLES.filter((r) => r !== role);

test("ROLES lists exactly the 7 known roles", () => {
  assert.deepEqual(ROLES, ["admin", "ceo", "sales_director", "sales_manager", "warehouse_manager", "delivery_manager", "accountant"]);
});

test("seesAllActivity: every role except sales_manager", () => {
  assert.equal(seesAllActivity("sales_manager"), false);
  for (const role of OTHER_ROLES("sales_manager")) assert.equal(seesAllActivity(role), true, role);
});

test("seesFinancialExports: admin/ceo/sales_director/accountant only", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant"]) assert.equal(seesFinancialExports(role), true, role);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager"]) assert.equal(seesFinancialExports(role), false, role);
});

test("canDeleteOrEditDirectly: admin only", () => {
  assert.equal(canDeleteOrEditDirectly("admin"), true);
  for (const role of OTHER_ROLES("admin")) assert.equal(canDeleteOrEditDirectly(role), false, role);
});

test("canReassignCustomers: admin/sales_director/ceo only", () => {
  for (const role of ["admin", "sales_director", "ceo"]) assert.equal(canReassignCustomers(role), true, role);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager", "accountant"]) assert.equal(canReassignCustomers(role), false, role);
});

test("canEditOwnSalesChannel: reassignment roles always can; sales_manager only on their own customer", () => {
  assert.equal(canEditOwnSalesChannel("admin", 5, 1), true);
  assert.equal(canEditOwnSalesChannel("sales_director", 5, 1), true);
  assert.equal(canEditOwnSalesChannel("ceo", 5, 1), true);
  assert.equal(canEditOwnSalesChannel("sales_manager", 1, 1), true, "own customer");
  assert.equal(canEditOwnSalesChannel("sales_manager", 2, 1), false, "someone else's customer");
  assert.equal(canEditOwnSalesChannel("warehouse_manager", 1, 1), false);
});

test("canAssignErpCustomerId: admin/ceo/accountant always; sales_manager/sales_director only on their own", () => {
  for (const role of ["admin", "ceo", "accountant"]) assert.equal(canAssignErpCustomerId(role, 99, 1), true, role);
  assert.equal(canAssignErpCustomerId("sales_manager", 1, 1), true);
  assert.equal(canAssignErpCustomerId("sales_manager", 2, 1), false);
  assert.equal(canAssignErpCustomerId("sales_director", 1, 1), true);
  assert.equal(canAssignErpCustomerId("sales_director", 2, 1), false);
  assert.equal(canAssignErpCustomerId("warehouse_manager", 1, 1), false);
});

test("canManageProducts: admin/ceo/accountant only", () => {
  for (const role of ["admin", "ceo", "accountant"]) assert.equal(canManageProducts(role), true, role);
  for (const role of ["sales_manager", "sales_director", "warehouse_manager", "delivery_manager"]) assert.equal(canManageProducts(role), false, role);
});

test("canViewTeamLocations: admin/sales_director/ceo only", () => {
  for (const role of ["admin", "sales_director", "ceo"]) assert.equal(canViewTeamLocations(role), true, role);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager", "accountant"]) assert.equal(canViewTeamLocations(role), false, role);
});

test("canPlanForOthers: admin/sales_director/ceo only", () => {
  for (const role of ["admin", "sales_director", "ceo"]) assert.equal(canPlanForOthers(role), true, role);
  assert.equal(canPlanForOthers("sales_manager"), false);
});

test("canConfirmOrders: admin/sales_director/ceo only", () => {
  for (const role of ["admin", "sales_director", "ceo"]) assert.equal(canConfirmOrders(role), true, role);
  assert.equal(canConfirmOrders("sales_manager"), false);
});

test("broadcastsLocation: every role except admin/ceo", () => {
  assert.equal(broadcastsLocation("admin"), false);
  assert.equal(broadcastsLocation("ceo"), false);
  for (const role of ["sales_manager", "sales_director", "warehouse_manager", "delivery_manager", "accountant"]) {
    assert.equal(broadcastsLocation(role), true, role);
  }
});

test("isPerfCeo: admin and ceo are treated as equivalent", () => {
  assert.equal(isPerfCeo("admin"), true);
  assert.equal(isPerfCeo("ceo"), true);
  assert.equal(isPerfCeo("sales_director"), false);
});

test("canEditChannelPlan: perf-CEO always; sales_director/accountant only their own owner_role", () => {
  assert.equal(canEditChannelPlan("admin", "sales_director"), true);
  assert.equal(canEditChannelPlan("ceo", "accountant"), true);
  assert.equal(canEditChannelPlan("sales_director", "sales_director"), true);
  assert.equal(canEditChannelPlan("sales_director", "accountant"), false);
  assert.equal(canEditChannelPlan("accountant", "accountant"), true);
  assert.equal(canEditChannelPlan("accountant", "sales_director"), false);
  assert.equal(canEditChannelPlan("sales_manager", "sales_director"), false);
});

test("canReviewPlan: perf-CEO reviews everything; accountant reviews only sales_director submissions", () => {
  assert.equal(canReviewPlan("admin", "sales_director"), true);
  assert.equal(canReviewPlan("ceo", "accountant"), true);
  assert.equal(canReviewPlan("accountant", "sales_director"), true);
  assert.equal(canReviewPlan("accountant", "accountant"), false, "accountant cannot approve their own submission");
  assert.equal(canReviewPlan("sales_director", "sales_director"), false, "director never reviews plans");
});

test("canReviseApprovedPlan: perf-CEO only", () => {
  assert.equal(canReviseApprovedPlan("admin"), true);
  assert.equal(canReviseApprovedPlan("ceo"), true);
  assert.equal(canReviseApprovedPlan("accountant"), false);
  assert.equal(canReviseApprovedPlan("sales_director"), false);
});

test("canReopenPlanAsDraft: perf-CEO, sales_director, accountant", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant"]) assert.equal(canReopenPlanAsDraft(role), true, role);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager"]) assert.equal(canReopenPlanAsDraft(role), false, role);
});

test("seesAllPerformance: admin/ceo/sales_director/accountant only", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant"]) assert.equal(seesAllPerformance(role), true, role);
  assert.equal(seesAllPerformance("sales_manager"), false);
});

test("canCloseMonth: perf-CEO and accountant only, never sales_director", () => {
  assert.equal(canCloseMonth("admin"), true);
  assert.equal(canCloseMonth("ceo"), true);
  assert.equal(canCloseMonth("accountant"), true);
  assert.equal(canCloseMonth("sales_director"), false);
});

test("canReviewPayments: admin/ceo/accountant only, not sales_director", () => {
  for (const role of ["admin", "ceo", "accountant"]) assert.equal(canReviewPayments(role), true, role);
  assert.equal(canReviewPayments("sales_director"), false);
  assert.equal(canReviewPayments("sales_manager"), false);
});

test("canSubmitPaymentsForOthers: admin/ceo/accountant/sales_director only", () => {
  for (const role of ["admin", "ceo", "accountant", "sales_director"]) assert.equal(canSubmitPaymentsForOthers(role), true, role);
  assert.equal(canSubmitPaymentsForOthers("sales_manager"), false);
});

test("seesAllPayments: mirrors seesAllActivity", () => {
  assert.equal(seesAllPayments("sales_manager"), false);
  for (const role of OTHER_ROLES("sales_manager")) assert.equal(seesAllPayments(role), true, role);
});

test("validHandoffRecipientRoles: the exact custody chain", () => {
  assert.deepEqual(validHandoffRecipientRoles("sales_manager"), ["sales_director"]);
  assert.deepEqual(validHandoffRecipientRoles("sales_director"), ["ceo", "accountant"]);
  assert.deepEqual(validHandoffRecipientRoles("ceo"), ["accountant"]);
  assert.deepEqual(validHandoffRecipientRoles("accountant"), [], "the terminal role is never a sender");
  assert.deepEqual(validHandoffRecipientRoles("admin"), []);
});

test("isTerminalHandoffRole: accountant only", () => {
  assert.equal(isTerminalHandoffRole("accountant"), true);
  assert.equal(isTerminalHandoffRole("ceo"), false, "CEO is only an intermediate custodian");
});

test("canSubmitHandoffForOthers: mirrors canSubmitPaymentsForOthers", () => {
  for (const role of ["admin", "ceo", "accountant", "sales_director"]) assert.equal(canSubmitHandoffForOthers(role), true, role);
  assert.equal(canSubmitHandoffForOthers("sales_manager"), false);
});

test("canManageWarehouse: warehouse_manager/sales_director/ceo/admin only", () => {
  for (const role of ["warehouse_manager", "sales_director", "ceo", "admin"]) assert.equal(canManageWarehouse(role), true, role);
  assert.equal(canManageWarehouse("delivery_manager"), false);
});

test("canPlanRoutes: delivery_manager/admin only", () => {
  assert.equal(canPlanRoutes("delivery_manager"), true);
  assert.equal(canPlanRoutes("admin"), true);
  assert.equal(canPlanRoutes("warehouse_manager"), false);
});

test("canDeliverOrders: delivery_manager/admin only", () => {
  assert.equal(canDeliverOrders("delivery_manager"), true);
  assert.equal(canDeliverOrders("admin"), true);
  assert.equal(canDeliverOrders("sales_director"), false);
});

test("canMarkDeliveredWithoutRoute: delivery_manager plus the office-side override roles", () => {
  for (const role of ["delivery_manager", "sales_director", "accountant", "ceo", "admin"]) {
    assert.equal(canMarkDeliveredWithoutRoute(role), true, role);
  }
  for (const role of ["sales_manager", "warehouse_manager"]) assert.equal(canMarkDeliveredWithoutRoute(role), false, role);
});

test("isFulfillmentRole: union of canManageWarehouse and canDeliverOrders", () => {
  for (const role of ["warehouse_manager", "sales_director", "ceo", "admin", "delivery_manager"]) assert.equal(isFulfillmentRole(role), true, role);
  for (const role of ["sales_manager", "accountant"]) assert.equal(isFulfillmentRole(role), false, role);
});

test("canRecordOrders: accountant/admin only", () => {
  assert.equal(canRecordOrders("accountant"), true);
  assert.equal(canRecordOrders("admin"), true);
  assert.equal(canRecordOrders("ceo"), false);
});

test("seesUnrecordedBadge: accountant/ceo/admin only, explicitly not sales_director", () => {
  for (const role of ["accountant", "ceo", "admin"]) assert.equal(seesUnrecordedBadge(role), true, role);
  assert.equal(seesUnrecordedBadge("sales_director"), false);
});

test("PAYMENT_NOTIFY_ROLES: accountant only, explicitly excludes CEO/admin", () => {
  assert.deepEqual(PAYMENT_NOTIFY_ROLES, ["accountant"]);
});

test("seesGeneratedReports: mirrors seesFinancialExports", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant"]) assert.equal(seesGeneratedReports(role), true, role);
  assert.equal(seesGeneratedReports("sales_manager"), false);
});

test("seesCustomerErpData: every role sees it, except a sales_manager viewing a customer not assigned to them", () => {
  for (const role of ["admin", "ceo", "sales_director", "accountant", "warehouse_manager", "delivery_manager"]) {
    assert.equal(seesCustomerErpData(role, 99, 1), true, role);
  }
  assert.equal(seesCustomerErpData("sales_manager", 1, 1), true, "own customer");
  assert.equal(seesCustomerErpData("sales_manager", 2, 1), false, "someone else's customer");
});

test("canManageBonusChallenges: admin/ceo only", () => {
  assert.equal(canManageBonusChallenges("admin"), true);
  assert.equal(canManageBonusChallenges("ceo"), true);
  for (const role of OTHER_ROLES("admin").filter((r) => r !== "ceo")) assert.equal(canManageBonusChallenges(role), false, role);
});

test("canApproveBonusRewards: mirrors canReviewPayments", () => {
  for (const role of ROLES) assert.equal(canApproveBonusRewards(role), canReviewPayments(role), role);
});

test("canRecordBonusPayouts: mirrors canRecordOrders", () => {
  for (const role of ROLES) assert.equal(canRecordBonusPayouts(role), canRecordOrders(role), role);
});
