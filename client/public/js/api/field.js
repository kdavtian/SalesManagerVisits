// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...fieldApi.
import { json, request, stripCompetitorIds } from "./core.js";

export const fieldApi = {
  reportFarAttempt: (data) => json("/checkins/far-attempt", "POST", data),
  createCheckin: (formData) =>
    request("/checkins", { method: "POST", body: formData }),
  getDeliverableOrders: (customerId) => request(`/checkins/deliverable-orders?customer_id=${customerId}`),
  listCheckins: (params = {}, options = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/checkins${qs ? `?${qs}` : ""}`, options);
  },
  checkinPhotoByIdUrl: (photoId) => `/api/checkins/photos/${photoId}`,
  checkinPhotoThumbUrl: (photoId) => `/api/checkins/photos/${photoId}?size=thumb`,
  deleteCheckinPhotoById: (photoId) => request(`/checkins/photos/${photoId}`, { method: "DELETE" }),
  fuelReport: (month, retry = false) => request(`/fuel/report?month=${month}${retry ? "&retry=1" : ""}`),
  fuelSettings: (month) => request(`/fuel/settings?month=${month}`),
  setFuelUser: (id, data) => json(`/fuel/settings/users/${id}`, "PUT", data),
  setFuelPrice: (month, price) => json(`/fuel/prices/${month}`, "PUT", { price_amd_per_l: price }),
  setFuelOverride: (data) => json("/fuel/overrides", "PUT", data),
  postLocation: (lat, lng) => json("/locations", "POST", { lat, lng }),
  getTeamLocations: () => request("/locations"),
  getMyVisitPlan: async (date, userId) => {
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (userId) params.set("user_id", userId);
    const qs = params.toString();
    const plan = await request(`/visit-plans/mine${qs ? `?${qs}` : ""}`);
    if (!plan || !Array.isArray(plan.customer_ids)) return plan;
    return { ...plan, customer_ids: stripCompetitorIds(plan.customer_ids) };
  },
  saveVisitPlan: (date, customerIds, userId) =>
    json("/visit-plans", "POST", { date, customer_ids: stripCompetitorIds(customerIds), user_id: userId }),
  getPendingVisitPlans: () => request("/visit-plans/pending"),
  getTeamTodayVisitPlans: () => request("/visit-plans/team-today"),
  reviewVisitPlan: (id, action) => json(`/visit-plans/${id}`, "PATCH", { action }),
  getVisitPlanRules: (userId) => request(`/visit-plans/rules${userId ? `?user_id=${userId}` : ""}`),
  // planChannel: "" = save the main plan, "SM B2B" = that channel's own plan (the person's other plans stay as they are);
  // undefined = replace the whole day (the Map's quick planner)
  saveVisitPlanRule: (dayOfWeek, areas, userId, customerIds, planChannel) =>
    json(`/visit-plans/rules/${dayOfWeek}`, "PUT", { areas, user_id: userId, customer_ids: stripCompetitorIds(customerIds), ...(planChannel === undefined ? {} : { plan_channel: planChannel }) }),
  listRoutePlanSets: () => request("/route-plan-sets"),
  autoRoutePlanSet: (data) => json("/route-plan-sets/auto", "POST", data),
  snapshotRoutePlanSet: (name) => json("/route-plan-sets/snapshot", "POST", { name }),
  getRoutePlanSet: (id) => request(`/route-plan-sets/${id}`),
  updateRoutePlanSet: (id, data) => json(`/route-plan-sets/${id}`, "PATCH", data),
  setRoutePlanSetRep: (id, userId, days, scope) => json(`/route-plan-sets/${id}/reps/${userId}`, "PUT", scope === undefined ? { days } : { days, scope }),
  duplicateRoutePlanSet: (id, name) => json(`/route-plan-sets/${id}/duplicate`, "POST", { name }),
  activateRoutePlanSet: (id, previousName) => json(`/route-plan-sets/${id}/activate`, "POST", { previous_name: previousName }),
  deleteRoutePlanSet: (id) => request(`/route-plan-sets/${id}`, { method: "DELETE" }),
  getRoutePlansOverview: () => request("/visit-plans/rules/overview"),
  // scope: "" = the main plan, "SM B2B" = that channel's separate plan; undefined = every customer of the person
  getRoutePlanCustomers: (userId, scope) => {
    const qs = [userId ? `user_id=${userId}` : "", scope === undefined ? "" : `scope=${encodeURIComponent(scope)}`].filter(Boolean).join("&");
    return request(`/visit-plans/rules/customers${qs ? `?${qs}` : ""}`);
  },
  getMyRoutePlans: (userId) => request(`/visit-plans/rules/plans${userId ? `?user_id=${userId}` : ""}`),
  listRouteDistribution: () => request("/route-distribution"),
  lookupRouteDistribution: (region, subregion) => {
    const qs = new URLSearchParams({ region, ...(subregion ? { subregion } : {}) }).toString();
    return request(`/route-distribution/lookup?${qs}`);
  },
  bulkRouteDistribution: (items) => json("/route-distribution/bulk", "PUT", { items }),
  createRouteDistribution: (data) => json("/route-distribution", "POST", data),
  updateRouteDistribution: (id, data) => json(`/route-distribution/${id}`, "PATCH", data),
  deleteRouteDistribution: (id) => request(`/route-distribution/${id}`, { method: "DELETE" }),
  getOpenVisit: (customerId) => request(`/checkins/open?customer_id=${customerId}`),
  endVisit: (checkinId) => request(`/checkins/${checkinId}/end`, { method: "POST" }),
};
