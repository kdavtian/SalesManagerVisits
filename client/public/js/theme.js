const THEME_KEY = "fieldvisits_theme";

export function getTheme() {
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function setTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, value);
  document.documentElement.dataset.theme = value;
}

export function applyStoredTheme() {
  document.documentElement.dataset.theme = getTheme();
}
