// Landing cost calculated by the app (owner, 2026-10-19): the Excel Products sheet gives the supplier price of a pack in USD
// (+ items per pack, kg, litres) and the app applies the cost model of the Products-page calculator (costModel.js: per-brand
// legal transport and real freight, ecology, customs, excise, import VAT, clearance) at the USD rate set in App configuration.
// The workbook's own Landing Cost AMD (rate 377.5, Excel formulas) stays in landing_workbook_amd: the fallback for a product
// without pack data and for an outlier, and the reference the Data quality check compares with.
import { pool } from "../db/pool.js";
import { COST_RATES_DEFAULT, landingCost } from "../../../client/public/js/costModel.js";

// A calculated value more than this far from the workbook's is not trusted (wrong pack data in Excel is far likelier than a real
// 20 % difference: the model reproduces the workbook within about 3 % at the same rate); the workbook's value stays and Data quality lists it.
export const OUTLIER_SHARE = 0.2;

// The landing-cost rates the owner can change in App configuration, with the range each one may take (a typo such as
// 5000 instead of 5 % must not silently wreck every product's cost). The values are the keys of costModel.js COST_RATES_DEFAULT.
export const LANDING_RATE_FIELDS = Object.freeze({
  tRealCastrol: [0, 5], // freight actually paid, USD per kg
  tRealRoyal: [0, 5],
  tRealLotos: [0, 5], // Lotos and Orlen come from the same factory
  tRealOther: [0, 5],
  tLegalCastrol: [0, 5], // freight declared on the customs invoice, USD per kg (part of the customs value)
  tLegalRoyal: [0, 5],
  tLegalLotos: [0, 5],
  tLegalOther: [0, 5],
  customs: [0, 50], // customs duty, % of the customs value
  eco: [0, 50], // ecology fee, % of the customs value
  excise: [0, 10000], // AMD per kg netto
  vat: [0, 50], // import VAT, %
  handling: [0, 5], // clearance, USD per litre
  otherUsd: [0, 100], // other costs, USD per item
});

const roundRate = (n) => Math.round(n * 1e6) / 1e6;

// overrides = what the owner changed; effective = the built-in value unless overridden (the numbers the calculation really uses).
function ratesFrom(overrides) {
  const effective = {};
  for (const key of Object.keys(LANDING_RATE_FIELDS)) {
    effective[key] = Number.isFinite(Number(overrides?.[key])) ? Number(overrides[key]) : COST_RATES_DEFAULT[key];
  }
  return effective;
}

// What the screen shows: the same numbers rounded alike, so a rate nobody changed equals its default (and shows as empty).
export const displayRates = (effective) => Object.fromEntries(Object.keys(LANDING_RATE_FIELDS).map((k) => [k, roundRate(effective[k])]));

export const landingRateDefaults = () => Object.fromEntries(Object.keys(LANDING_RATE_FIELDS).map((k) => [k, roundRate(COST_RATES_DEFAULT[k])]));

export async function getLandingSettings(db = pool) {
  const { rows } = await db.query("SELECT landing_calc_enabled, landing_usd_rate, retail_from_excel, landing_cost_rates FROM app_settings WHERE id = 1");
  const overrides = rows[0]?.landing_cost_rates ?? {};
  return {
    enabled: rows[0]?.landing_calc_enabled ?? true,
    rate: Number(rows[0]?.landing_usd_rate ?? COST_RATES_DEFAULT.rate),
    retailFromExcel: rows[0]?.retail_from_excel ?? false,
    overrides,
    rates: ratesFrom(overrides),
  };
}

export async function setLandingSetting(field, value, db = pool) {
  const column = { enabled: "landing_calc_enabled", rate: "landing_usd_rate", retailFromExcel: "retail_from_excel" }[field];
  if (!column) throw new Error(`unknown landing setting ${field}`);
  await db.query(`INSERT INTO app_settings (id, ${column}) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [value]);
}

// input: { key: number | null } for any of LANDING_RATE_FIELDS (null = back to the built-in value). Throws an Error whose
// message names the first bad entry; nothing is saved then. Returns the effective rates.
export async function setLandingRates(input, db = pool) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("landing_rates must be an object");
  const { overrides } = await getLandingSettings(db);
  const next = { ...overrides };
  for (const [key, raw] of Object.entries(input)) {
    const range = LANDING_RATE_FIELDS[key];
    if (!range) throw new Error(`unknown landing rate ${key}`);
    if (raw === null || raw === "") {
      delete next[key];
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error(`${key} must be between ${range[0]} and ${range[1]}`);
    // A value equal to the built-in one is not an override: it keeps following the code's default.
    if (roundRate(value) === roundRate(COST_RATES_DEFAULT[key])) delete next[key];
    else next[key] = roundRate(value);
  }
  await db.query(
    "INSERT INTO app_settings (id, landing_cost_rates) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET landing_cost_rates = EXCLUDED.landing_cost_rates",
    [JSON.stringify(next)]
  );
  return displayRates(ratesFrom(next));
}

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

// Landing cost in AMD per item for one products row, or null when the pack data is incomplete.
export function calculatedLandingAmd(row, rate, rates = null) {
  const packCostUsd = positive(row.pack_cost_usd);
  const items = positive(row.items_per_pack);
  const packKg = positive(row.pack_netto_kg);
  const size = positive(row.size_l);
  if (!packCostUsd || !items || !packKg || !size) return null;
  const { amd } = landingCost({ brand: row.brand, size, items, packKg, packCostUsd }, { ...COST_RATES_DEFAULT, ...(rates ?? {}), rate });
  return Number.isFinite(amd) && amd > 0 ? Math.round(amd * 100) / 100 : null;
}

// Decides landing_cost_amd + landing_source for products (all, or only the given ERP ids) and writes them.
// `db` is a pool or a transaction client. Returns { calculated, workbook }.
export async function applyLandingCosts(db = pool, erpIds = null) {
  const settings = await getLandingSettings(db);
  const { rows } = await db.query(
    `SELECT id, brand, pack_cost_usd, items_per_pack, pack_netto_kg, size_l, landing_workbook_amd
       FROM products WHERE ($1::text[] IS NULL OR erp_product_id = ANY($1))`,
    [erpIds]
  );
  const ids = [];
  const amounts = [];
  const sources = [];
  for (const row of rows) {
    const workbook = positive(row.landing_workbook_amd);
    const calc = settings.enabled ? calculatedLandingAmd(row, settings.rate, settings.rates) : null;
    // The workbook computes at its own rate (377.5), so the comparison is made at that rate: only a data error shows as a big gap.
    const likeWorkbook = calc && workbook ? calculatedLandingAmd(row, 377.5) : null;
    const outlier = likeWorkbook && workbook && Math.abs(likeWorkbook / workbook - 1) > OUTLIER_SHARE;
    ids.push(row.id);
    if (calc && !outlier) {
      amounts.push(calc);
      sources.push("calculated");
    } else {
      amounts.push(workbook);
      sources.push(workbook ? "workbook" : null);
    }
  }
  if (ids.length) {
    await db.query(
      `UPDATE products p SET landing_cost_amd = t.amount, landing_source = t.source
         FROM unnest($1::int[], $2::numeric[], $3::text[]) AS t(id, amount, source)
        WHERE p.id = t.id AND (p.landing_cost_amd IS DISTINCT FROM t.amount OR p.landing_source IS DISTINCT FROM t.source)`,
      [ids, amounts, sources]
    );
  }
  return { calculated: sources.filter((s) => s === "calculated").length, workbook: sources.filter((s) => s === "workbook").length };
}

// Retail prices from Excel (owner, 2026-10-19: "yes, from Excel"): while retail_from_excel is on, every product whose workbook
// Retail Price differs from the app's takes it (like bronze/silver/gold, a hand edit does not freeze it). Changes go to the price
// history. Returns the number of products changed.
export async function applyExcelRetail(db = pool, erpIds = null) {
  const { rows } = await db.query(
    `UPDATE products p SET retail_price_amd = p.erp_retail_price_amd, updated_at = now()
       FROM (SELECT id, retail_price_amd AS old FROM products) s
      WHERE p.id = s.id AND p.erp_retail_price_amd > 0 AND p.retail_price_amd IS DISTINCT FROM p.erp_retail_price_amd
        AND ($1::text[] IS NULL OR p.erp_product_id = ANY($1))
      RETURNING p.id, s.old AS old_value, p.retail_price_amd AS new_value`,
    [erpIds]
  );
  for (const r of rows) {
    if (r.old_value === null || Number(r.old_value) === Number(r.new_value)) continue;
    await db.query(
      `INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note) VALUES ($1, 'retail', $2, $3, NULL, 'ERP sync')`,
      [r.id, r.old_value, r.new_value]
    );
  }
  return rows.length;
}

// What switching "Retail price from Excel" on would change (the owner's before/after list).
export async function retailDifferences(db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, brand, unit, COALESCE(retail_price_amd, unit_price_amd)::float8 AS app_retail, erp_retail_price_amd::float8 AS excel_retail
       FROM products
      WHERE active AND erp_retail_price_amd > 0 AND COALESCE(retail_price_amd, unit_price_amd) IS DISTINCT FROM erp_retail_price_amd
      ORDER BY brand, name, unit`
  );
  return rows;
}
