import { hyCommon } from "./i18n/hy/common.js";
import { hyCustomers } from "./i18n/hy/customers.js";
import { hyOrders } from "./i18n/hy/orders.js";
import { hyField } from "./i18n/hy/field.js";
import { hyMoney } from "./i18n/hy/money.js";
import { hyProducts } from "./i18n/hy/products.js";
import { hyReports } from "./i18n/hy/reports.js";
import { hyTeam } from "./i18n/hy/team.js";
import { hySettings } from "./i18n/hy/settings.js";
// Armenian texts (the default language). Loaded only when the device language is Armenian (see i18n.js).
// The texts live in i18n/hy/<area>.js, one file per area of the app (common = shell, login, Home, errors and texts several areas use;
// docs/architecture-roadmap.md step 8b); this file joins them. A new text goes into its area's file, in BOTH languages: the same key in
// i18n/en/<area>.js and i18n/hy/<area>.js (server/test/integration/i18nParity.test.js checks every pair).
const hy = {
  ...hyCommon,
  ...hyCustomers,
  ...hyOrders,
  ...hyField,
  ...hyMoney,
  ...hyProducts,
  ...hyReports,
  ...hyTeam,
  ...hySettings,
};
export default hy;
// The area files, for i18n.js: a text missing after an update makes it fetch each of them again, fresh (see refreshOnMiss there).
export const AREAS = ["common", "customers", "orders", "field", "money", "products", "reports", "team", "settings"];
