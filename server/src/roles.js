export const ROLES = ["admin", "manager", "sales_director", "warehouse_manager", "delivery_manager"];

// Managers only see their own data; every other role sees everyone's
// (admins can also delete/edit directly, the others cannot).
export function seesAllActivity(role) {
  return role !== "manager";
}

export function canDeleteOrEditDirectly(role) {
  return role === "admin";
}

// Per spec: only admin and sales_director see the live team-location map.
export function canViewTeamLocations(role) {
  return role === "admin" || role === "sales_director";
}

// Every field-facing role (i.e. not admin) broadcasts its own foreground
// location while the app is open, so admin/sales_director have something
// to look at.
export function broadcastsLocation(role) {
  return role !== "admin";
}
