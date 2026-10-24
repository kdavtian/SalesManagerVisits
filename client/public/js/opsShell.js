import { t } from "./i18n.js";
import { formatDuration } from "./util.js";

// Role shells (owner, 2026-10-23): the warehouse manager and the delivery driver get their own small app -- a different Home, only the tabs they
// work in, nothing else reachable -- instead of the sales rep's app with tiles hidden. Everyone else keeps the normal app.
// `tabs` are the bottom-nav tabs; `allowed` is every screen the role may open (anything else goes back to Home).
export const OPS_SHELLS = {
  warehouse_manager: {
    tabs: [
      { hash: "#/dashboard", label: "nav_dashboard", icon: "home" },
      { hash: "#/wh-pack", label: "ops_tab_pack", icon: "box", badge: "warehouse" },
      { hash: "#/orders", label: "nav_orders", icon: "cart" },
      { hash: "#/pricelist", label: "ops_tab_products", icon: "tag" },
      { hash: "#/tasks", label: "qa_tasks", icon: "tasks" },
    ],
    allowed: [/^#\/dashboard/, /^#\/wh-pack/, /^#\/warehouse/, /^#\/delivery/, /^#\/orders/, /^#\/pricelist/, /^#\/product\//, /^#\/tasks/, /^#\/returns/, /^#\/staff/, /^#\/notifications/, /^#\/settings/],
  },
  delivery_manager: {
    tabs: [
      { hash: "#/dashboard", label: "nav_dashboard", icon: "home" },
      { hash: "#/delivery", label: "ops_tab_route", icon: "truck", badge: "delivery" },
      { hash: "#/orders", label: "nav_orders", icon: "cart" },
      { hash: "#/tasks", label: "qa_tasks", icon: "tasks" },
    ],
    allowed: [/^#\/dashboard/, /^#\/delivery/, /^#\/orders/, /^#\/tasks/, /^#\/staff/, /^#\/notifications/, /^#\/settings/],
  },
};

export function opsShellFor(role) {
  return OPS_SHELLS[role] ?? null;
}

export function shellAllows(role, hash) {
  const shell = OPS_SHELLS[role];
  if (!shell) return true;
  const path = (hash || "#/dashboard").split("?")[0] || "#/dashboard";
  return shell.allowed.some((re) => re.test(path));
}

// "3h 20m" for a few hours, "16d" once it is more than two days (a number of hours that big is not a waiting time any more, it is a forgotten order).
export function formatAge(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return m >= 2880 ? t("ops_age_days").replace("{n}", String(Math.floor(m / 1440))) : formatDuration(m);
}
