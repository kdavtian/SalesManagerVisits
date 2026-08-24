// Inline SVG icons matching the approved design mockups — kept as plain
// strings (no icon font/emoji) so they render identically across devices.

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

// Primary navigation icons use a shared 24 px grid and optical stroke weight.
// Keeping them as vectors makes them perfectly sharp at every screen density.
const navSvg = (content, attributes = stroke) =>
  `<svg class="nav-svg" viewBox="0 0 24 24" width="24" height="24" ${attributes} aria-hidden="true" focusable="false">${content}</svg>`;
const uiSvg = (content, attributes = stroke) =>
  `<svg class="ui-svg" viewBox="0 0 24 24" width="22" height="22" ${attributes} aria-hidden="true" focusable="false">${content}</svg>`;

export const icons = {
  dashboard: navSvg(`<path d="M3.25 10.75 12 3l8.75 7.75"/><path d="M5.25 9.75v8.5c0 1.1.9 2 2 2h2.4v-5.1a2.35 2.35 0 0 1 4.7 0v5.1h2.4c1.1 0 2-.9 2-2v-8.5"/>`),
  activity: navSvg(`<rect x="2.25" y="11.25" width="3.25" height="9.5" rx="1.625"/><rect x="7.67" y="4.25" width="3.25" height="16.5" rx="1.625"/><rect x="13.08" y="9.25" width="3.25" height="11.5" rx="1.625"/><rect x="18.5" y="13.75" width="3.25" height="7" rx="1.625"/>`, `fill="currentColor"`),
  map: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 11 22 2 13 21 11 13z"/></svg>`,
  customers: navSvg(`<circle cx="12" cy="6.75" r="2.75"/><circle cx="5.45" cy="8.05" r="2.15"/><circle cx="18.55" cy="8.05" r="2.15"/><path d="M6.25 20v-1.3a5.75 5.75 0 0 1 11.5 0V20"/><path d="M1.9 18.3v-.9a4.25 4.25 0 0 1 4.25-4.25c.72 0 1.4.18 2 .5M22.1 18.3v-.9a4.25 4.25 0 0 0-4.25-4.25c-.72 0-1.4.18-2 .5"/>`),
  settings: navSvg(`<path d="M9.35 3.15h5.3l.55 2.05c.48.2.94.46 1.36.78l2.06-.56 2.65 4.58-1.5 1.5a7.7 7.7 0 0 1 0 1.57l1.5 1.5-2.65 4.58-2.06-.56c-.42.32-.88.58-1.36.78l-.55 2.05h-5.3l-.55-2.05a7.5 7.5 0 0 1-1.36-.78l-2.06.56-2.65-4.58 1.5-1.5a7.7 7.7 0 0 1 0-1.57L2.73 10l2.65-4.58 2.06.56c.42-.32.88-.58 1.36-.78l.55-2.05Z"/><circle cx="12" cy="12.28" r="3.05"/>`),
  locate: `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M12 5v14M5 12h14"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M5 12h14"/></svg>`,
  team: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>`,
  sort: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M6 4v16M6 4l-3 3M6 4l3 3M18 20V4M18 20l-3-3M18 20l3-3"/></svg>`,
  planDay: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M8 3v3M16 3v3"/><path d="M7.5 14l2 2 4-4.5"/></svg>`,
  store: uiSvg(`<path d="M4 10v10h16V10M3 10l2-6h14l2 6"/><path d="M3 10a2.5 2.5 0 0 0 4.5 1.5A2.5 2.5 0 0 0 12 10a2.5 2.5 0 0 0 4.5 1.5A2.5 2.5 0 0 0 21 10"/><path d="M9 20v-5h6v5"/>`),
  pin: uiSvg(`<path d="M20 10c0 5.5-8 11-8 11S4 15.5 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>`),
  clock: uiSvg(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>`),
  chart: uiSvg(`<path d="M4 20V11M10 20V4M16 20v-7M22 20V8"/>`),
  compass: uiSvg(`<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>`),
  phone: uiSvg(`<path d="M7.2 3.5 10 7.8 8.2 10a15.5 15.5 0 0 0 5.8 5.8l2.2-1.8 4.3 2.8-.8 3.2c-.2.8-1 1.3-1.8 1.2A18 18 0 0 1 2.8 6.1C2.7 5.3 3.2 4.5 4 4.3z"/>`),
  history: uiSvg(`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>`),
  cart: uiSvg(`<circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/><path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L21 8H6"/>`),
  noOrder: uiSvg(`<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>`),
  payment: uiSvg(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3"/>`),
  door: uiSvg(`<path d="M5 21h14M7 21V4l10-1v18"/><circle cx="14" cy="12" r=".7" fill="currentColor" stroke="none"/>`),
  warning: uiSvg(`<path d="M10.3 4.2 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>`),
  box: uiSvg(`<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/>`),
  more: uiSvg(`<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>`),
  tag: uiSvg(`<path d="M20 13 13 20l-9-9V4h7z"/><circle cx="8" cy="8" r="1"/>`),
  repeat: uiSvg(`<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>`),
  note: uiSvg(`<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>`),
  clipboardCheck: uiSvg(`<rect x="5.5" y="4.5" width="13" height="16.5" rx="2"/><path d="M9 4.5V3.7a1.7 1.7 0 0 1 1.7-1.7h2.6A1.7 1.7 0 0 1 15 3.7v.8"/><path d="M8.8 12.2l2.1 2.1 4.3-4.8"/>`),
};
