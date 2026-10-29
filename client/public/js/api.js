// Every server request, as ONE `api` object (import { api } from "./api.js"; screens never call fetch themselves). The requests live in
// js/api/<area>.js, one file per business area, the same areas as server/src/<area>/ (docs/architecture-roadmap.md step 8a); request(),
// json(), the short GET cache, CSRF and timeouts are in js/api/core.js. A new request goes into its area's file. Architecture check 9
// fails when two area files define the same method (the later spread would silently win).
import { systemApi } from "./api/system.js";
import { customersApi } from "./api/customers.js";
import { ordersApi } from "./api/orders.js";
import { reportsApi } from "./api/reports.js";
import { fieldApi } from "./api/field.js";
import { productsApi } from "./api/products.js";
import { teamApi } from "./api/team.js";
import { moneyApi } from "./api/money.js";
import { erpApi } from "./api/erp.js";
import { bonusApi } from "./api/bonus.js";
export { prefetchGet } from "./api/core.js";

export const api = {
  ...systemApi,
  ...customersApi,
  ...ordersApi,
  ...reportsApi,
  ...fieldApi,
  ...productsApi,
  ...teamApi,
  ...moneyApi,
  ...erpApi,
  ...bonusApi,
};
