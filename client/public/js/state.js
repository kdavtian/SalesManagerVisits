export const state = {
  user: null,
};

export function setUser(user) {
  state.user = user;
}

export function isAdmin() {
  return state.user?.role === "admin";
}

// Managers only see their own data; every other role (admin + the three
// director-tier roles) sees everyone's — mirrors server/src/roles.js.
export function seesAllActivity() {
  return state.user?.role !== "manager";
}

export function canEditDirectly() {
  return state.user?.role === "admin";
}

export function canViewTeamLocations() {
  return state.user?.role === "admin" || state.user?.role === "sales_director";
}

export function broadcastsLocation() {
  return state.user?.role !== "admin";
}
