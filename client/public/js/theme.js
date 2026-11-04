const THEME_KEY = "fieldvisits_theme";

// The iPhone status bar takes the theme-color (it is a solid bar since 2026-11-04, see index.html): page background of the theme.
export function paintStatusBar(theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#000000" : "#f6f7f9";
}

export function getTheme() {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function setTheme(theme) {
  const value = theme === "dark" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, value);
  document.documentElement.dataset.theme = value;
  paintStatusBar(value);
}

export function applyStoredTheme() {
  document.documentElement.dataset.theme = getTheme();
  paintStatusBar(getTheme());
}
