// Inline SVG icons matching the approved design mockups — kept as plain
// strings (no icon font/emoji) so they render identically across devices.

const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

export const icons = {
  dashboard: `<svg viewBox="0 0 24 24" width="22" height="22" ${stroke}><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="22" height="22" ${stroke}><path d="M4 20V10M10 20V4M16 20v-7M22 20v-4"/></svg>`,
  map: `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M2.5 21.5l19-9.5-19-9.5v7.5l13 2-13 2z"/></svg>`,
  customers: `<svg viewBox="0 0 24 24" width="22" height="22" ${stroke}><circle cx="8.5" cy="8" r="3.2"/><path d="M2.5 20c0-3.6 2.7-6.2 6-6.2s6 2.6 6 6.2"/><circle cx="17" cy="9" r="2.6"/><path d="M14.5 13.6c2.7.3 4.7 2.6 4.7 5.4"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="22" height="22" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9V10c.1.7.6 1.3 1.6 1.4h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.1z"/></svg>`,
  locate: `<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M12 5v14M5 12h14"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><path d="M5 12h14"/></svg>`,
  team: `<svg viewBox="0 0 24 24" width="20" height="20" ${stroke}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>`,
};
