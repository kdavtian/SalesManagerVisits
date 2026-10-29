// Part of the `api` object of ../api.js (docs/architecture-roadmap.md, step 8): joined back there with ...erpApi.
import { json, request } from "./core.js";

export const erpApi = {
  getUnlinkedErpCustomers: (search = "") => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    return request(`/erp-sync/unlinked${qs}`);
  },
  getErpSyncStatus: () => request("/erp-sync/status", { fresh: true }),
  requestErpSync: () => json("/erp-sync/request", "POST", {}),
};
