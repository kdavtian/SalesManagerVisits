export const state = {
  user: null,
};

export function setUser(user) {
  state.user = user;
}

export function isAdmin() {
  return state.user?.role === "admin";
}
