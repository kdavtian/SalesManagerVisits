// The Pivot report's cross-tab: turns the server's grouped rows (reports/pivot/query.js runSpec: each row = [dims..., values..., g],
// g = GROUPING bit mask, the first dimension the highest bit) into rows x columns with true totals. Pure: the screen draws it, the
// export sends it, the tests check it.
const SEP = "\u0001";
const keyOf = (parts) => parts.map((p) => (p == null ? "" : String(p))).join(SEP);

/**
 * result: { rowsN, colsN, valuesN, cells }. Returns { rowKeys: [[...]], colKeys: [[...]], cell(r, c), rowTotal(r), colTotal(c), grand }
 * (each a list of valuesN numbers, or null when the combination has no rows).
 */
export function buildMatrix(result) {
  const { rowsN, colsN, valuesN, cells } = result;
  const n = rowsN + colsN;
  const bit = (g, i) => (g >> (n - 1 - i)) & 1;
  const allRowsGrouped = (g) => rowsN === 0 || Array.from({ length: rowsN }, (_, i) => bit(g, i)).every(Boolean);
  const noRowsGrouped = (g) => Array.from({ length: rowsN }, (_, i) => bit(g, i)).every((b) => !b);
  const allColsGrouped = (g) => colsN === 0 || Array.from({ length: colsN }, (_, i) => bit(g, rowsN + i)).every(Boolean);
  const noColsGrouped = (g) => Array.from({ length: colsN }, (_, i) => bit(g, rowsN + i)).every((b) => !b);

  const body = new Map();
  const rowTotals = new Map();
  const colTotals = new Map();
  let grand = null;
  const rowKeys = new Map();
  const colKeys = new Map();
  for (const c of cells) {
    const g = c[n + valuesN] ?? 0;
    const r = c.slice(0, rowsN);
    const k = c.slice(rowsN, n);
    const vals = c.slice(n, n + valuesN);
    // the grand total first: with no row (or no column) dimension the "every dimension grouped" test is also true for the others
    if (allRowsGrouped(g) && allColsGrouped(g) && (n === 0 || g !== 0)) grand = vals;
    else if (noRowsGrouped(g) && noColsGrouped(g)) {
      if (rowsN && colsN) body.set(`${keyOf(r)}${SEP}${SEP}${keyOf(k)}`, vals);
      if (rowsN && !rowKeys.has(keyOf(r))) rowKeys.set(keyOf(r), r);
      if (colsN && !colKeys.has(keyOf(k))) colKeys.set(keyOf(k), k);
      if (rowsN && !colsN) rowTotals.set(keyOf(r), vals);
      if (colsN && !rowsN) colTotals.set(keyOf(k), vals);
    } else if (noRowsGrouped(g) && allColsGrouped(g)) rowTotals.set(keyOf(r), vals);
    else if (allRowsGrouped(g) && noColsGrouped(g)) colTotals.set(keyOf(k), vals);
  }
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] == null) return 1;
      if (b[i] == null) return -1;
      const na = Number(a[i]);
      const nb = Number(b[i]);
      const c = Number.isFinite(na) && Number.isFinite(nb) && String(a[i]).trim() !== "" && String(b[i]).trim() !== "" ? na - nb : String(a[i]).localeCompare(String(b[i]));
      if (c) return c;
    }
    return 0;
  };
  return {
    rowsN,
    colsN,
    valuesN,
    rowKeys: [...rowKeys.values()].sort(cmp),
    colKeys: [...colKeys.values()].sort(cmp),
    cell: (r, k) => body.get(`${keyOf(r)}${SEP}${SEP}${keyOf(k)}`) ?? null,
    rowTotal: (r) => rowTotals.get(keyOf(r)) ?? null,
    colTotal: (k) => colTotals.get(keyOf(k)) ?? null,
    grand,
  };
}

/**
 * The matrix as one flat table (what the screen shows and what is exported):
 *   { header, rows, total, numeric } -- labels come from the caller: dimLabel(dimIndex, raw), valueLabel(valueIndex), colLabel(colKey),
 *   totalLabel. `sort` = { col: index into the row (after the row headers), dir } reorders the body rows.
 */
export function flattenMatrix(m, { rowDimLabels, valueLabels, dimLabel, colLabel, totalLabel, sort = null }) {
  const multiV = m.valuesN > 1;
  const header = [...rowDimLabels];
  const numeric = rowDimLabels.map(() => false);
  const colBlocks = m.colsN ? [...m.colKeys.map((k) => ({ k })), { total: true }] : [{ total: true }];
  for (const b of colBlocks) {
    for (let v = 0; v < m.valuesN; v++) {
      const top = b.total ? (m.colsN ? totalLabel : "") : colLabel(b.k);
      header.push([top, multiV || !top ? valueLabels[v] : ""].filter(Boolean).join(" · ") || valueLabels[v]);
      numeric.push(true);
    }
  }
  const valuesFor = (r) => colBlocks.flatMap((b) => (b.total ? m.rowTotal(r) : m.cell(r, b.k)) ?? Array(m.valuesN).fill(null));
  let rows = m.rowKeys.map((r) => [...r.map((raw, i) => dimLabel(i, raw)), ...valuesFor(r)]);
  if (sort && sort.col != null) {
    const i = sort.col;
    const dir = sort.dir === "asc" ? 1 : -1;
    rows = rows
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => {
        const x = a.row[i];
        const y = b.row[i];
        if (x == null && y == null) return a.idx - b.idx;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return c * dir || a.idx - b.idx;
      })
      .map((x) => x.row);
  }
  const totalVals = colBlocks.flatMap((b) => (b.total ? m.grand : m.colTotal(b.k)) ?? Array(m.valuesN).fill(null));
  const total = [...(rowDimLabels.length ? [totalLabel, ...rowDimLabels.slice(1).map(() => "")] : []), ...totalVals];
  return { header, rows, total, numeric };
}
