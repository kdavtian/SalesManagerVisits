export const state = {
  user: null,
};

export function setUser(user) {
  state.user = user;
}

export function isAdmin() {
  return state.user?.role === "admin";
}

// Sales managers only see their own data; every other role sees
// everyone's — mirrors server/src/roles.js.
export function seesAllActivity() {
  return state.user?.role !== "sales_manager";
}

export function canEditDirectly() {
  return state.user?.role === "admin";
}

export function canViewTeamLocations() {
  return (
    state.user?.role === "admin" || state.user?.role === "sales_director" || state.user?.role === "ceo"
  );
}

export function broadcastsLocation() {
  return state.user?.role !== "admin" && state.user?.role !== "ceo";
}
