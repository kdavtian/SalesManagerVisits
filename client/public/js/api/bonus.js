// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...bonusApi.
import { json, request } from "./core.js";

export const bonusApi = {
  // Bonuses challenge templates/rounds admin (see server/src/bonus/routes/bonusChallenges.js)
  // -- canManageBonusChallenges (admin/ceo) server-side already.
  listChallengeTemplates: (status) => request(`/bonus-challenges/templates${status ? `?status=${status}` : ""}`),
  getChallengeTemplate: (id) => request(`/bonus-challenges/templates/${id}`),
  createChallengeTemplate: (data) => json("/bonus-challenges/templates", "POST", data),
  updateChallengeTemplate: (id, data) => json(`/bonus-challenges/templates/${id}`, "PATCH", data),
  publishChallengeTemplate: (id) => json(`/bonus-challenges/templates/${id}/publish`, "POST"),
  cancelChallengeTemplate: (id, reason) => json(`/bonus-challenges/templates/${id}/cancel`, "POST", { reason }),
  // Reward claim review/payout (see server/src/bonus/routes/bonusRewardClaims.js)
  // -- listing is role-scoped server-side already (a reviewer sees
  // everything, a plain user sees only their own).
  listBonusRewardClaims: (status) => request(`/bonus-reward-claims${status ? `?status=${status}` : ""}`),
  approveBonusRewardClaim: (id, expectedVersion) => json(`/bonus-reward-claims/${id}/approve`, "POST", { expected_version: expectedVersion }),
  rejectBonusRewardClaim: (id, reason, expectedVersion) =>
    json(`/bonus-reward-claims/${id}/reject`, "POST", { reason, expected_version: expectedVersion }),
  holdBonusRewardClaim: (id, reason, expectedVersion) => json(`/bonus-reward-claims/${id}/hold`, "POST", { reason, expected_version: expectedVersion }),
  payBonusRewardClaim: (id, paymentReference, expectedVersion) =>
    json(`/bonus-reward-claims/${id}/pay`, "POST", { payment_reference: paymentReference, expected_version: expectedVersion }),
  // Employee-facing "my Bonuses" summary (see server/src/bonus/routes/bonusSummary.js)
  // -- always scoped to the caller; 404s while bonuses_enabled is off.
  getBonusSummary: () => request("/bonus-summary"),
};
