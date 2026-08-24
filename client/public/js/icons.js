// Inline SVG icons matching the approved design mockups — kept as plain
// strings (no icon font/emoji) so they render identically across devices.

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

// Primary navigation icons use a shared 24 px grid and optical stroke weight.
// Keeping them as vectors makes them perfectly sharp at every screen density.
const navSvg = (content, attributes = stroke) =>
  `<svg class="nav-svg" viewBox="0 0 24 24" width="24" height="24" ${attributes} aria-hidden="true" focusable="false">${content}</svg>`;

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
};
