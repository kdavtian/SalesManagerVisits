import { enCommon } from "./i18n/en/common.js";
import { enCustomers } from "./i18n/en/customers.js";
import { enOrders } from "./i18n/en/orders.js";
import { enField } from "./i18n/en/field.js";
import { enMoney } from "./i18n/en/money.js";
import { enProducts } from "./i18n/en/products.js";
import { enReports } from "./i18n/en/reports.js";
import { enTeam } from "./i18n/en/team.js";
import { enSettings } from "./i18n/en/settings.js";
// English texts. Loaded only when the device language is English (see i18n.js).
// The texts live in i18n/en/<area>.js, one file per area of the app (common = shell, login, Home, errors and texts several areas use;
// docs/architecture-roadmap.md step 8b); this file joins them. A new text goes into its area's file, in BOTH languages: the same key in
// i18n/en/<area>.js and i18n/hy/<area>.js (server/test/integration/i18nParity.test.js checks every pair).
const en = {
  ...enCommon,
  ...enCustomers,
  ...enOrders,
  ...enField,
  ...enMoney,
  ...enProducts,
  ...enReports,
  ...enTeam,
  ...enSettings,
};
export default en;
// The area files, for i18n.js: a text missing after an update makes it fetch each of them again, fresh (see refreshOnMiss there).
export const AREAS = ["common", "customers", "orders", "field", "money", "products", "reports", "team", "settings"];
