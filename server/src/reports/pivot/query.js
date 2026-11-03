// The Pivot report's query builder (sources.js holds every piece of SQL; this file only puts them together). The browser sends a spec
// of field KEYS, aggregations, date buckets and filter values: keys are looked up in the source (unknown = 400), values always go in as
// parameters, so no text from the browser ever becomes SQL.
//   spec: { source, mode: "pivot" | "list",
//           rows: [{ field, bucket? }], cols: [{ field, bucket? }] (at most 2), values: [{ field ("*" = rows), agg }],
//           fields: [field] (list mode), filters: [{ field, op, value }], sort: { field, dir } (list mode), limit }
import { SOURCE_BY_KEY } from "./sources.js";

export const AGGS = ["count", "count_distinct", "sum", "avg", "min", "max"];
export const BUCKETS = ["day", "week", "month", "quarter", "year", "weekday"];
const MAX_DIMS = 4;
const MAX_VALUES = 8;
export const MAX_GROUP_ROWS = 50000;
export const MAX_LIST_ROWS = 20000;

export class SpecError extends Error {}

function fieldOf(source, key) {
  const f = source.fields.find((x) => x.key === key);
  if (!f) throw new SpecError(`Unknown field: ${key}`);
  return f;
}

// A dimension's SQL: a date can be grouped by day / week (Monday) / month / quarter / year / weekday.
function dimExpr(f, bucket) {
  if (f.type !== "date" || !bucket || bucket === "day") return f.type === "date" ? `to_char(${f.expr}, 'YYYY-MM-DD')` : f.type === "bool" ? `(${f.expr})::text` : `(${f.expr})`;
  if (!BUCKETS.includes(bucket)) throw new SpecError(`Unknown date grouping: ${bucket}`);
  if (bucket === "week") return `to_char(date_trunc('week', ${f.expr})::date, 'YYYY-MM-DD')`;
  if (bucket === "month") return `to_char(${f.expr}, 'YYYY-MM')`;
  if (bucket === "quarter") return `to_char(${f.expr}, 'YYYY-"Q"Q')`;
  if (bucket === "year") return `to_char(${f.expr}, 'YYYY')`;
  return `EXTRACT(ISODOW FROM ${f.expr})::int::text`;
}

function aggExpr(source, v) {
  if (!AGGS.includes(v.agg)) throw new SpecError(`Unknown aggregation: ${v.agg}`);
  if (v.field === "*") return { sql: "count(*)", needs: [] };
  const f = fieldOf(source, v.field);
  if (v.agg === "count") return { sql: `count(${f.expr})`, needs: [f] };
  if (v.agg === "count_distinct") return { sql: `count(DISTINCT ${f.expr})`, needs: [f] };
  if (f.type !== "number" && !(f.type === "date" && (v.agg === "min" || v.agg === "max"))) throw new SpecError(`${v.agg} needs a number field`);
  const fn = { sum: "sum", avg: "avg", min: "min", max: "max" }[v.agg];
  return { sql: f.type === "date" ? `to_char(${fn}(${f.expr}), 'YYYY-MM-DD')` : `${fn}((${f.expr})::numeric)::float8`, needs: [f] };
}

// One filter -> a SQL condition with its values as parameters.
function filterSql(source, flt, param) {
  const f = fieldOf(source, flt.field);
  const e = f.type === "bool" ? `(${f.expr})::text` : `(${f.expr})`;
  const v = flt.value;
  switch (flt.op) {
    case "in":
    case "not_in": {
      const list = (Array.isArray(v) ? v : [v]).map((x) => (x === null ? null : String(x)));
      const vals = list.filter((x) => x !== null);
      const hasNull = list.length !== vals.length;
      const inSql = vals.length ? `${e}::text = ANY(${param(vals)}::text[])` : "false";
      const cond = hasNull ? `(${inSql} OR ${e} IS NULL)` : inSql;
      return flt.op === "in" ? cond : `NOT COALESCE(${cond}, false)`;
    }
    case "contains":
      return `${e}::text ILIKE ${param(`%${String(v ?? "").replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`;
    case "not_contains":
      return `COALESCE(${e}::text, '') NOT ILIKE ${param(`%${String(v ?? "").replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`;
    case "empty":
      return `(${e} IS NULL OR ${e}::text = '')`;
    case "not_empty":
      return `(${e} IS NOT NULL AND ${e}::text <> '')`;
    case "eq":
      return f.type === "number" ? `${e} = ${param(Number(v))}` : `${e}::text = ${param(String(v))}`;
    case "gte":
    case "lte": {
      const opSql = flt.op === "gte" ? ">=" : "<=";
      if (f.type === "number") return `${e} ${opSql} ${param(Number(v))}`;
      if (f.type === "date") return `${e} ${opSql} ${param(String(v))}::date`;
      throw new SpecError("A range needs a number or a date field");
    }
    case "between": {
      const [a, b] = Array.isArray(v) ? v : [];
      const parts = [];
      if (a != null && a !== "") parts.push(f.type === "date" ? `${e} >= ${param(String(a))}::date` : `${e} >= ${param(Number(a))}`);
      if (b != null && b !== "") parts.push(f.type === "date" ? `${e} <= ${param(String(b))}::date` : `${e} <= ${param(Number(b))}`);
      return parts.length ? parts.join(" AND ") : "true";
    }
    case "last_days": {
      if (f.type !== "date") throw new SpecError("last_days needs a date field");
      const n = Math.max(0, Math.min(3650, Math.trunc(Number(v)) || 0));
      return `${e} >= (now() AT TIME ZONE 'Asia/Yerevan')::date - ${param(n)}::int`;
    }
    default:
      throw new SpecError(`Unknown filter: ${flt.op}`);
  }
}

/**
 * Builds { sql, params, kind } for a spec. Pure apart from source.prepare (the live debt). `extra` lets the values endpoint ask for one
 * field's distinct values.
 */
export async function compile(db, spec, extra = null) {
  const source = SOURCE_BY_KEY.get(spec?.source);
  if (!source) throw new SpecError("Unknown data source");
  const mode = extra ? "values" : spec.mode === "list" ? "list" : "pivot";
  const rows = (spec.rows ?? []).slice(0, MAX_DIMS);
  const cols = (spec.cols ?? []).slice(0, 2);
  const values = (spec.values?.length ? spec.values : [{ field: "*", agg: "count" }]).slice(0, MAX_VALUES);
  const listFields = (spec.fields ?? []).slice(0, 40);
  const filters = (spec.filters ?? []).slice(0, 30).filter((f) => !extra || f.field !== extra.field);

  // which optional joins the used fields need
  const used = [];
  const take = (key) => used.push(fieldOf(source, key));
  if (mode === "pivot") {
    [...rows, ...cols].forEach((d) => take(d.field));
    values.forEach((v) => v.field !== "*" && take(v.field));
  } else if (mode === "list") listFields.forEach(take);
  else take(extra.field);
  filters.forEach((f) => take(f.field));
  if (mode === "list" && spec.sort?.field) take(spec.sort.field);
  const joins = new Set(used.map((f) => f.join).filter(Boolean));

  const params = source.prepare ? await source.prepare(db, joins) : [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const joinSql = [...joins].map((j) => source.joins[j].replace(/:p(\d+)/g, (_, i) => `$${Number(i) + 1}`)).join("\n");
  const conds = [source.where, ...filters.map((f) => filterSql(source, f, param))].filter(Boolean);
  const base = `${source.from}\n${joinSql}${conds.length ? `\nWHERE ${conds.join("\n  AND ")}` : ""}`;

  if (mode === "values") {
    const f = fieldOf(source, extra.field);
    const e = dimExpr(f, extra.bucket);
    const search = extra.q ? `HAVING ${e}::text ILIKE ${param(`%${String(extra.q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}` : "";
    return { kind: "values", params, sql: `SELECT ${e} AS v, count(*)::int AS n ${base}\nGROUP BY 1 ${search}\nORDER BY 2 DESC, 1 LIMIT 300` };
  }

  if (mode === "list") {
    if (!listFields.length) throw new SpecError("Choose the fields to show");
    const sel = listFields.map((k, i) => {
      const f = fieldOf(source, k);
      return `${f.type === "date" ? `to_char(${f.expr}, 'YYYY-MM-DD')` : f.type === "number" ? `(${f.expr})::float8` : f.expr} AS f${i}`;
    });
    let order = "";
    if (spec.sort?.field) order = `ORDER BY ${fieldOf(source, spec.sort.field).expr} ${spec.sort.dir === "desc" ? "DESC" : "ASC"} NULLS LAST`;
    const limit = Math.min(MAX_LIST_ROWS, Math.max(1, Number(spec.limit) || MAX_LIST_ROWS));
    return { kind: "list", params, fields: listFields, sql: `SELECT ${sel.join(", ")} ${base}\n${order}\nLIMIT ${limit + 1}`, limit };
  }

  // pivot: the cells, the row totals, the column totals and the grand total in one pass (GROUPING SETS), so every aggregation --
  // also a distinct count or an average -- has true totals
  const dims = [...rows, ...cols].map((d, i) => `${dimExpr(fieldOf(source, d.field), d.bucket)} AS d${i}`);
  values.forEach((v) => aggExpr(source, v)); // validates each aggregation against its field
  const rIdx = rows.map((_, i) => `d${i}`);
  const cIdx = cols.map((_, i) => `d${rows.length + i}`);
  const sets = new Set([[...rIdx, ...cIdx], rIdx, cIdx, []].map((s) => `(${s.join(", ")})`));
  const all = [...rIdx, ...cIdx];
  const grouping = all.length ? `, GROUPING(${all.join(", ")}) AS g` : ", 0 AS g";
  const inner = `SELECT ${[...dims, ...values.map((v, i) => (v.field === "*" ? `1 AS x${i}` : `${fieldOf(source, v.field).expr} AS x${i}`))].join(", ")} ${base}`;
  // the aggregations over the inner query's columns: replace each field expression with its column
  const outerAggs = values.map((v, i) => {
    if (v.field === "*") return `count(*)::float8 AS v${i}`;
    const f = fieldOf(source, v.field);
    const col = `s.x${i}`;
    if (v.agg === "count") return `count(${col})::float8 AS v${i}`;
    if (v.agg === "count_distinct") return `count(DISTINCT ${col})::float8 AS v${i}`;
    if (f.type === "date") return `to_char(${v.agg}(${col}), 'YYYY-MM-DD') AS v${i}`;
    return `${v.agg}((${col})::numeric)::float8 AS v${i}`;
  });
  const sql = `SELECT ${[...all.map((d) => `s.${d}`), ...outerAggs].join(", ")}${grouping.replace(/d(\d+)/g, "s.d$1")}
FROM (${inner}) s
GROUP BY ${all.length ? `GROUPING SETS (${[...sets].join(", ")})` : "()"}
LIMIT ${MAX_GROUP_ROWS + 1}`;
  return { kind: "pivot", params, sql, rows: rows.length, cols: cols.length, values: values.length };
}

// Runs a compiled query with a time limit (a pivot over everything must never hold the database).
export async function runQuery(pool, compiled) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '25s'");
    const { rows } = await client.query(compiled.sql, compiled.params);
    await client.query("COMMIT");
    return rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Runs a spec: { kind, rows / cells, truncated, ms }. */
export async function runSpec(pool, spec) {
  const started = Date.now();
  const compiled = await compile(pool, spec);
  const out = await runQuery(pool, compiled);
  if (compiled.kind === "list") {
    const truncated = out.length > compiled.limit;
    return { kind: "list", fields: compiled.fields, rows: out.slice(0, compiled.limit).map((r) => compiled.fields.map((_, i) => r[`f${i}`])), truncated, ms: Date.now() - started };
  }
  const truncated = out.length > MAX_GROUP_ROWS;
  const nDims = compiled.rows + compiled.cols;
  // each result row: [dims..., values...] plus the grouping bit mask (1 = that dimension is a total)
  const cells = out.slice(0, MAX_GROUP_ROWS).map((r) => [
    ...Array.from({ length: nDims }, (_, i) => r[`d${i}`]),
    ...Array.from({ length: compiled.values }, (_, i) => (r[`v${i}`] == null ? null : typeof r[`v${i}`] === "string" ? r[`v${i}`] : Number(r[`v${i}`]))),
    Number(r.g),
  ]);
  return { kind: "pivot", rowsN: compiled.rows, colsN: compiled.cols, valuesN: compiled.values, cells, truncated, ms: Date.now() - started };
}

export async function distinctValues(pool, spec, field, q, bucket) {
  const compiled = await compile(pool, spec, { field, q, bucket });
  return (await runQuery(pool, compiled)).map((r) => ({ v: r.v, n: r.n }));
}
