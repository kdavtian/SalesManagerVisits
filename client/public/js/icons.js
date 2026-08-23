// Inline SVG icons matching the approved design mockups — kept as plain
// strings (no icon font/emoji) so they render identically across devices.

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const icons = {
  dashboard: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5 12 3l8.5 7.5"/><path d="M5 9.5V19a1.5 1.5 0 0 0 1.5 1.5H9V15a3 3 0 0 1 6 0v5.5h2.5A1.5 1.5 0 0 0 19 19V9.5"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="2" y="12" width="3.2" height="9" rx="1.6"/><rect x="7.6" y="5" width="3.2" height="16" rx="1.6"/><rect x="13.2" y="10" width="3.2" height="11" rx="1.6"/><rect x="18.8" y="15" width="3.2" height="6" rx="1.6"/></svg>`,
  map: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 11 22 2 13 21 11 13z"/></svg>`,
  customers: `<svg viewBox="0 0 24 24" width="22" height="22" ${stroke}><circle cx="5.8" cy="8.2" r="2.3"/><circle cx="12" cy="7" r="2.8"/><circle cx="18.2" cy="8.2" r="2.3"/><path d="M2.2 19.5c0-2.7 1.6-4.7 3.6-4.7"/><path d="M18.2 14.8c2 0 3.6 2 3.6 4.7"/><path d="M6.4 19.8c0-3.4 2.5-6 5.6-6s5.6 2.6 5.6 6"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="6.4"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3.4v1.4M12 19.2v1.4M20.6 12h-1.4M4.8 12H3.4M17.6 6.4l-1 1M7.4 16.6l-1 1M17.6 17.6l-1-1M7.4 7.4l-1-1"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M12 5v14M5 12h14"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M5 12h14"/></svg>`,
  team: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>`,
  sort: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M6 4v16M6 4l-3 3M6 4l3 3M18 20V4M18 20l-3-3M18 20l3-3"/></svg>`,
  planDay: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><rect x="3.5" y="4.5" width="17" height="16" rx="2.5"/><path d="M3.5 9.5h17"/><path d="M8 3v3M16 3v3"/><path d="M7.5 14l2 2 4-4.5"/></svg>`,
};
