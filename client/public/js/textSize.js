// Accessibility: bigger text. Stored on the device (same pattern as theme.js / perfMode.js); applied before first paint
// by theme-init.js as html[data-text-size], which styles.css turns into a larger root font size. Every rem-based size
// in the app (most of them) grows with it.
const KEY = "fieldvisits_text_size";
export const TEXT_SIZES = ["normal", "large", "xlarge"];

export function getTextSize() {
  try {
    const v = localStorage.getItem(KEY);
    return TEXT_SIZES.includes(v) ? v : "normal";
  } catch {
    return "normal";
  }
}

export function setTextSize(size) {
  const value = TEXT_SIZES.includes(size) ? size : "normal";
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private mode: applies for this session only */
  }
  applyTextSize();
}

export function applyTextSize() {
  const v = getTextSize();
  if (v === "normal") delete document.documentElement.dataset.textSize;
  else document.documentElement.dataset.textSize = v;
}
