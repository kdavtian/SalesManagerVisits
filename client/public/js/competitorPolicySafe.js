// Competitors are market-intelligence records, not visit-required customers.
// This wraps only the specific Field Visits API methods involved in visit
// status/planning. It deliberately does NOT intercept window.fetch.
import { api } from "./api.js";

if (!api.__kadCompetitorPolicyInstalled) {
  Object.defineProperty(api, "__kadCompetitorPolicyInstalled", { value: true });

  const competitorIds = new Set();
  const remember = (rows) => {
    for (const c of Array.isArray(rows) ? rows : rows ? [rows] : []) {
      if (c?.customer_tier === "competitor" && Number.isInteger(Number(c.id))) competitorIds.add(Number(c.id));
    }
  };
  const stripCompetitorIds = (ids) =>
    Array.isArray(ids) ? ids.filter((id) => !competitorIds.has(Number(id))) : ids;

  const originalListCustomers = api.listCustomers.bind(api);
  api.listCustomers = async (params = {}) => {
    const rows = await originalListCustomers(params);
    remember(rows);
    const operationalQueue = params?.visited === "overdue" || params?.visited === "not_visited";
    return rows
      .filter((c) => !(operationalQueue && c?.customer_tier === "competitor"))
      .map((c) => c?.customer_tier === "competitor" ? { ...c, overdue: false, visit_required: false } : c);
  };

  const originalGetCustomer = api.getCustomer.bind(api);
  api.getCustomer = async (id) => {
    const c = await originalGetCustomer(id);
    remember(c);
    return c?.customer_tier === "competitor" ? { ...c, overdue: false, visit_required: false } : c;
  };

  const originalGetMyVisitPlan = api.getMyVisitPlan.bind(api);
  api.getMyVisitPlan = async (...args) => {
    const plan = await originalGetMyVisitPlan(...args);
    if (!plan || !Array.isArray(plan.customer_ids)) return plan;
    return { ...plan, customer_ids: stripCompetitorIds(plan.customer_ids) };
  };

  const originalSaveVisitPlan = api.saveVisitPlan.bind(api);
  api.saveVisitPlan = (date, customerIds, userId) =>
    originalSaveVisitPlan(date, stripCompetitorIds(customerIds), userId);

  const originalSaveVisitPlanRule = api.saveVisitPlanRule.bind(api);
  api.saveVisitPlanRule = (dayOfWeek, areas, userId, customerIds) =>
    originalSaveVisitPlanRule(dayOfWeek, areas, userId, stripCompetitorIds(customerIds));
}
