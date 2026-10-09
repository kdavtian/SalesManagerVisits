// One icon per filter FEATURE, used by every search/filter bar in the app
// (Activity, Orders, Customers, Pricelist, Payments, Map, Warehouse...), so
// the same icon always means the same thing wherever it appears:
//
//   manager   a person/team member filter (sales manager, assigned rep)
//   status    a state filter (verified / visited / pending ...)
//   outcome   what happened (visit outcome)
//   channel   the sales direction / channel
//   category  the customer's type (shop, workshop ...)
//   brands    product brands on the shelf / pricelist brand tree
//   region    where (region / province)
//   subregion a finer area inside a region
//   sort      sort order
//   size      package size
//   columns   which columns to show
//   special   promo / special price only
//   filters   a multi-dimension filter sheet (more than one thing inside)
//
// Every glyph is drawn on the same 24px grid with a 1.9 stroke, rounded caps
// and joins, so they sit together as one family. A new filter should reuse one
// of these or add one here -- never draw its own inline SVG.
const svg = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;

export const FILTER_ICONS = {
  manager: svg('<circle cx="9" cy="8" r="3"/><circle cx="17.5" cy="8.6" r="2.35"/><path d="M3.5 20v-1.2A5.5 5.5 0 0 1 9 13.3h.1a5.5 5.5 0 0 1 5.5 5.5V20"/><path d="M15.1 13.8c.7-.35 1.5-.55 2.35-.55A4.55 4.55 0 0 1 22 17.8V20"/>'),
  status: svg('<circle cx="12" cy="12" r="8.75"/><path d="m7.9 12.1 2.6 2.7 5.8-6"/>'),
  outcome: svg('<rect x="5" y="3.75" width="14" height="16.5" rx="2.5"/><path d="M9 3.75v-.5A1.25 1.25 0 0 1 10.25 2h3.5A1.25 1.25 0 0 1 15 3.25v.5"/><path d="m8.5 11.7 1.8 1.8 4.7-5"/><path d="M8.5 17h7"/>'),
  channel: svg('<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M8 6h8M12 8v8M8 6c2.6 0 4 1.4 4 4M16 6c-2.6 0-4 1.4-4 4"/>'),
  category: svg('<path d="M4 10v10h16V10"/><path d="M3 10l2-6h14l2 6"/><path d="M3 10a2.5 2.5 0 0 0 4.5 1.5A2.5 2.5 0 0 0 12 10a2.5 2.5 0 0 0 4.5 1.5A2.5 2.5 0 0 0 21 10"/><path d="M9.5 20v-4.5h5V20"/>'),
  brands: svg('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>'),
  region: svg('<path d="M19 10c0 4.8-7 10-7 10S5 14.8 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.25"/>'),
  subregion: svg('<circle cx="12" cy="12" r="8.75"/><path d="m15.3 8.7-2 4.6-4.6 2 2-4.6z"/>'),
  sort: svg('<path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3"/>'),
  columns: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.2 4.5v15M14.8 4.5v15"/>'),
  size: svg('<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="m7 12 2.2 2.2M10 9l1.6 1.6M13 6l2.2 2.2"/>'),
  special: svg('<path d="M20 13 13 20l-9-9V4h7z"/><circle cx="8" cy="8" r="1"/>'),
  filters: svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  overdue: svg('<path d="M10.25 4.35 2.7 17.5a2.2 2.2 0 0 0 1.9 3.3h14.8a2.2 2.2 0 0 0 1.9-3.3L13.75 4.35a2 2 0 0 0-3.5 0Z"/><path d="M12 9v4.25M12 17h.01"/>'),
  recent: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  planned: svg('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="m9 15.2 2 2 4-4.2"/>'),
  nearby: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="8" stroke-opacity=".35"/>'),
};
