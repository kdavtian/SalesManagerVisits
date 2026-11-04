// The screens a person may pin (owner, 2026-11-04: "pinned screens", up to 4 per person, on the top of Home and of the desktop sidebar).
// Shared by the phone app and the server (server/src/shared/screens.js re-exports it), so the server checks a pin against exactly the
// list the app offers: the bottom tabs (not Home itself), the Home tiles this role sees (the admin's tile visibility; Bonuses only while
// bonuses are on) and the Bank & cash desks for the roles that record bank payments. The warehouse manager's and the driver's own small apps
// have all their screens in their tabs: they pin nothing.
import { visibleQuickActionIds } from "../quickActions.js";
import { canRecordBankPayments } from "./roles.js";

export const MAX_PINS = 4;
export const OPS_SHELL_ROLES = ["warehouse_manager", "delivery_manager"];

// The bottom tabs a pin can point at (Home is where the pins are shown, so it is not one of them).
export const TAB_SCREENS = [
  { id: "tab_activity", hash: "#/activity", label: "nav_activity" },
  { id: "tab_map", hash: "#/map", label: "nav_map" },
  { id: "tab_customers", hash: "#/customers", label: "nav_customers" },
  { id: "tab_orders", hash: "#/orders", label: "nav_orders" },
];

// Screens outside the Home grid (one click on the computer): [id, hash, allowed(role)]
export const EXTRA_SCREENS = [{ id: "qa_bank_desk", hash: "#/bank-desk", allowed: canRecordBankPayments }];

/** Every screen id this role may pin, in the order the app lists them. */
export function pinnableScreenIds(role, visibility, { bonusesEnabled = false } = {}) {
  if (!role || OPS_SHELL_ROLES.includes(role)) return [];
  const tiles = visibleQuickActionIds(role, visibility).filter((id) => id !== "qa_bonuses" || bonusesEnabled);
  const extra = EXTRA_SCREENS.filter((s) => s.allowed(role)).map((s) => s.id);
  return [...TAB_SCREENS.map((s) => s.id), ...tiles, ...extra];
}

/** The saved pins this role may still open, at most MAX_PINS, without repeats (a tile the admin hid since is dropped, not shown). */
export function cleanPins(pins, allowedIds) {
  if (!Array.isArray(pins)) return [];
  const allowed = new Set(allowedIds);
  return [...new Set(pins.filter((id) => typeof id === "string" && allowed.has(id)))].slice(0, MAX_PINS);
}
