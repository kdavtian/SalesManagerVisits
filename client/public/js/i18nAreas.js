// Which texts a screen needs before it is drawn (docs/architecture-roadmap.md step 11; i18n.js loads them). Every screen gets `common`
// (shell, login, Home, errors, texts several areas use) plus the areas listed for its address here; an address not listed (a customer
// card #/customers/123, a new screen) gets every area first -- always correct, just not the faster path. The other areas load right after
// the first screen, in the background.
//
// The lists come from the code: the areas of the texts used by each screen's file and everything it imports. server/test/integration/
// i18nRouteAreas.test.js recomputes them and fails when a screen starts using texts of an area missing here (add the area to its list).

// The text area files in i18n/<lang>/ (the same list as AREAS in i18n-en.js / i18n-hy.js and the preload list in theme-init.js).
export const TEXT_AREAS = ["common", "customers", "orders", "field", "money", "products", "reports", "team", "settings"];

export const ROUTE_TEXT_AREAS = {
  "#/wh-home": ["orders"],
  "#/driver-home": [],
  "#/cashflow": ["money"],
  "#/returns": ["orders"],
  "#/staff": ["team"],
  "#/wh-pack": ["customers", "money", "orders"],
  "#/stock-count": ["orders"],
  "#/activity": ["customers", "field", "money", "orders"],
  "#/map": ["customers", "field", "orders"],
  "#/customers": ["customers", "orders"],
  "#/orders": ["customers", "money", "orders"],
  "#/payments": ["money"],
  "#/cash-handoffs": ["money"],
  "#/money": [],
  "#/expenses": ["money"],
  "#/reports": ["money", "reports"],
  "#/route-distribution": ["field"],
  "#/route-plans": ["field"],
  "#/ops-control": ["team"],
  "#/ask-kad": ["team"],
  "#/vaghinak": ["team"],
  "#/team-progress": ["reports"],
  "#/team-performance": ["reports"],
  "#/company-dashboard": [],
  "#/pricelist": ["products"],
  "#/warehouse": ["customers", "money", "orders"],
  "#/delivery": ["orders"],
  "#/accounting": ["customers", "money", "orders"],
  "#/documents": ["money"],
  "#/recorded": ["orders"],
  "#/debt-balances": ["money"],
  "#/sales": ["money", "products"],
  "#/settings": ["customers", "settings"],
  "#/notifications": [],
  "#/tasks": ["field", "orders"],
  "#/bonuses": ["team"],
  "#/dashboard": ["orders"], // a warehouse manager's Home is the warehouse screen (views/warehouseHome.js)
};

export function firstTextAreas(hash) {
  let path = (hash || "").split("?")[0];
  if (path === "" || path === "#" || path === "#/") path = "#/dashboard"; // the app opens on Home
  const areas = ROUTE_TEXT_AREAS[path];
  return areas ? ["common", ...areas] : TEXT_AREAS;
}
