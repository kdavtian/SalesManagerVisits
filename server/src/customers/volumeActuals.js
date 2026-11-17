// Customer volume potential, phase 2 (owner, 2026-11-17): what a customer really buys from us per product line (ERP order lines, the trusted
// source; matched by Customer ID) against the potential the rep wrote, so share of wallet and the gap in litres can be shown and ranked.
//
// Mapping a product to a line: management's own decision first (volume_potential_sku_map), else fixed rules on the product's range / family
// and name (viscosity grade, ATF / CVT / DCT / gear words, coolant, brake, grease, EV). The rules never guess: a product they cannot place
// exactly (a 15W-40 that is not a known car or truck range, a "Transmission" product with no type word, a grade the catalogue has no line for,
// no size) is "unmapped" and listed in Settings for management to decide.
import { pool } from "../db/pool.js";
import { yerevanToday } from "../utils/yerevanDate.js";

// ---- the product -> line rules -----------------------------------------------------------------------------------------------------------
const PCMO_RANGES = /\b(EDGE|MAGNATEC|GTX)\b/;
const HDEO_RANGES = /\b(VECTON|CRB|TECTION|ELIXION|ENDURON)\b/;
const NOT_A_LINE_FAMILIES = new Set(["merch", "hydraulic"]);

export function gradeOf(name) {
  const m = String(name ?? "").toUpperCase().match(/\b(\d{1,2})\s*W\s*-?\s*(\d{1,3})\b/);
  return m ? `${Number(m[1])}w${Number(m[2])}` : null;
}

// One product -> { code, reason }: code is a catalogue line code ("pcmo_5w30", "atf" ...), or null with the reason it stays unmapped.
export function autoLineCode({ name, family, brand } = {}) {
  const n = ` ${String(name ?? "")} `.toUpperCase();
  const fam = String(family ?? "").trim().toLowerCase();
  const isCastrol = String(brand ?? "").trim().toLowerCase() === "castrol";
  if (NOT_A_LINE_FAMILIES.has(fam)) return { code: null, reason: "family_not_a_line" };
  if (/CLEANER|SPRAY/.test(n)) return { code: null, reason: "no_rule" }; // brake / parts cleaner sprays are no fluid line
  // Castrol ON (EV fluids) first: an EV thermal fluid is not a coolant line
  if (fam === "on" || (isCastrol && /\bON\b/.test(n) && /THERMAL|E-?TRANSMISSION|E-?DRIVE|EV\b/.test(n))) {
    if (/THERMAL|COOLANT/.test(n)) return { code: "ev_thermal", reason: "rule" };
    if (/TRANSMISSION|E-?DRIVE/.test(n)) return { code: "ev_transmission", reason: "rule" };
    return { code: null, reason: "ev_unclear" };
  }
  if (/\bBRAKE\s+FLUID\b|\bDOT\s*-?\s*[345]/.test(n)) return { code: "brake", reason: "rule" };
  if (fam === "antifreeze" || /RADICOOL|ANTIFREEZE|COOLANT|ANTIFRIZ/.test(n)) return { code: "coolant", reason: "rule" };
  if (fam === "grease" || /\bGREASE\b|SPHEEROL|\bLMX\b/.test(n)) return { code: "grease", reason: "rule" };
  // transmission fluids: exactly one type word, or it waits for a person
  const kinds = [];
  if (/\bCVT\b/.test(n)) kinds.push("cvt");
  if (/\bDCT\b|\bDSG\b|DUAL[- ]CLUTCH/.test(n)) kinds.push("dct");
  if (/\bATF\b|DEXRON|MERCON|MULTIVEHICLE/.test(n)) kinds.push("atf");
  if (/\b(70|75|80|85)\s*W\s*-?\s*(80|85|90|110|140)\b|\bMANUAL\b|\bAXLE\b|\bGEAR\b|\bHYPOY/.test(n)) kinds.push("gear");
  if (fam === "transmission" || kinds.length) {
    if (kinds.length === 1) return { code: kinds[0], reason: "rule" };
    return { code: null, reason: kinds.length ? "transmission_several" : "transmission_unclear" };
  }
  // engine oils: the grade, and car vs truck from the range
  const grade = gradeOf(n);
  if (!grade) return { code: null, reason: fam === "other" ? "family_other" : "no_rule" };
  let kind = null;
  if (PCMO_RANGES.test(n) || ["edge", "magnatec", "gtx"].includes(fam)) kind = "pcmo";
  else if (HDEO_RANGES.test(n) || ["crb", "vecton"].includes(fam)) kind = "hdeo";
  // no known car or truck range: a person decides (a 5W-40 can be a car, truck or motorcycle oil -- never guessed; review, 2026-11-17)
  if (!kind || /\b(4T|2T|POWER\s*1|MOTO)\b/.test(n)) return { code: null, reason: "car_or_truck_unclear" };
  return { code: `${kind}_${grade}`, reason: "rule" };
}

// "4", "4L", "4 l", "0.4kg", "208" -> number; anything else -> null
export function sizeOf(v) {
  const m = String(v ?? "").trim().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*(l|kg|լ)?$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const SKU_KEY_SQL = (t) => `COALESCE(NULLIF(lower(trim(${t}.product_id)), ''), lower(concat_ws('', ${t}.brand, ${t}.product_name, ${t}.size_l)))`;
const NOT_INTERNAL = "erp_customer_id <> '10000'"; // the company's own shop/office customer (as the litres report)

// Every product sold in the last 12 months with its line: { sku_key, name, brand, family, size, line_id, line_code, litres_per_unit,
// status: manual | auto | not_a_line | unmapped, reason, qty_12m, last_sale }.
// Read for every card and report: kept one minute, dropped at once when management changes a product or a line (clearSkuMappings).
let cache = null;
export function clearSkuMappings() {
  cache = null;
}
export async function skuMappings(db = pool) {
  if (db === pool && cache && Date.now() - cache.at < 60 * 1000) return cache.rows;
  const rows = await readSkuMappings(db);
  if (db === pool) cache = { at: Date.now(), rows };
  return rows;
}
async function readSkuMappings(db) {
  const [{ rows: skus }, { rows: lines }, { rows: decided }] = await Promise.all([
    db.query(
      `SELECT k.sku_key, MAX(k.product_name) AS name, MAX(k.brand) AS brand, MAX(k.size_l) AS size_txt,
              MAX(p.family) AS family, MAX(p.size_l)::float8 AS p_size, SUM(COALESCE(k.qty, 0))::float8 AS qty_12m, MAX(k.order_date) AS last_sale
         FROM (SELECT ${SKU_KEY_SQL("l")} AS sku_key, l.* FROM erp_order_lines l
                WHERE l.order_date >= $1::date AND l.${NOT_INTERNAL}) k
         LEFT JOIN products p ON lower(p.erp_product_id) = k.sku_key
        GROUP BY k.sku_key`,
      [addMonths(yerevanToday(), -12)]
    ),
    db.query("SELECT id, code, unit FROM volume_potential_lines"),
    db.query("SELECT sku_key, line_id, not_a_line, litres_per_unit::float8 AS litres_per_unit FROM volume_potential_sku_map"),
  ]);
  const idOf = new Map(lines.map((l) => [l.code, l.id]));
  const codeOf = new Map(lines.map((l) => [l.id, l.code]));
  const kgIds = new Set(lines.filter((l) => l.unit === "kg").map((l) => l.id));
  const manual = new Map(decided.map((d) => [d.sku_key, d]));
  return skus.map((s) => withUnit(s, manual.get(s.sku_key)));
  function withUnit(s, m) {
    const r = place(s, m);
    return { ...r, kg: r.line_id != null && kgIds.has(r.line_id) };
  }
  function place(s, m) {
    const size = m?.litres_per_unit ?? sizeOf(s.size_txt) ?? (s.p_size > 0 ? s.p_size : null);
    const base = { sku_key: s.sku_key, name: s.name, brand: s.brand, family: s.family, size, qty_12m: s.qty_12m, last_sale: s.last_sale, litres_per_unit: size, manual_litres: m?.litres_per_unit ?? null };
    if (m?.not_a_line) return { ...base, line_id: null, line_code: null, status: "not_a_line", reason: "manual" };
    if (m?.line_id) return size ? { ...base, line_id: m.line_id, line_code: codeOf.get(m.line_id), status: "manual", reason: "manual" } : { ...base, line_id: m.line_id, line_code: codeOf.get(m.line_id), status: "unmapped", reason: "no_size" };
    const auto = autoLineCode(s);
    if (auto.reason === "family_not_a_line") return { ...base, line_id: null, line_code: null, status: "not_a_line", reason: auto.reason };
    const lineId = auto.code ? idOf.get(auto.code) : null;
    if (!lineId) return { ...base, line_id: null, line_code: null, status: "unmapped", reason: auto.code ? "no_catalogue_line" : auto.reason };
    if (!size) return { ...base, line_id: lineId, line_code: auto.code, status: "unmapped", reason: "no_size" };
    return { ...base, line_id: lineId, line_code: auto.code, status: "auto", reason: "rule" };
  }
}

export async function saveSkuMapping(skuKey, userId, b, db = pool) {
  const key = String(skuKey ?? "").trim().toLowerCase().slice(0, 300);
  if (!key) throw Object.assign(new Error("Bad product"), { status: 400 });
  const notALine = b?.not_a_line === true;
  const lineId = notALine || b?.line_id == null || b?.line_id === "" ? null : Number(b.line_id);
  if (lineId !== null && !(Number.isInteger(lineId) && lineId > 0)) throw Object.assign(new Error("Bad line"), { status: 400 });
  const litres = b?.litres_per_unit == null || b?.litres_per_unit === "" ? null : Number(b.litres_per_unit);
  if (litres !== null && !(Number.isFinite(litres) && litres > 0 && litres <= 10000)) throw Object.assign(new Error("Bad litres"), { status: 400 });
  if (lineId !== null && !(await db.query("SELECT 1 FROM volume_potential_lines WHERE id = $1", [lineId])).rowCount) throw Object.assign(new Error("Bad line"), { status: 400 });
  // nothing decided = back to the rules
  if (!notALine && lineId === null && litres === null) {
    await db.query("DELETE FROM volume_potential_sku_map WHERE sku_key = $1", [key]);
    return { sku_key: key, cleared: true };
  }
  const { rows: [r] } = await db.query(
    `INSERT INTO volume_potential_sku_map (sku_key, line_id, not_a_line, litres_per_unit, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (sku_key) DO UPDATE SET line_id = EXCLUDED.line_id, not_a_line = EXCLUDED.not_a_line, litres_per_unit = EXCLUDED.litres_per_unit,
       updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
    [key, lineId, notALine, litres, userId]
  );
  return r;
}

// ---- actuals ---------------------------------------------------------------------------------------------------------------------------
function addMonths(ymd, n) {
  const [y, m] = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}
// The last three whole calendar months (Yerevan), e.g. on 17 Nov: 1 Aug .. 31 Oct. Averaged per month.
export function actualsWindow(today = yerevanToday()) {
  const thisMonth = `${today.slice(0, 7)}-01`;
  const from = addMonths(thisMonth, -3);
  const to = new Date(Date.UTC(+thisMonth.slice(0, 4), +thisMonth.slice(5, 7) - 1, 0)).toISOString().slice(0, 10);
  return { from, to, months: 3 };
}

// Map customer id -> { by_line: { [line_id]: litres a month }, total, unmapped } for the given customers (null = every customer).
// total = the litres of mapped products; unmapped = litres of products not yet placed (shown so a low share is not misread).
export async function customerActuals(customerIds = null, db = pool, { mappings = null, window = actualsWindow() } = {}) {
  const maps = new Map((mappings ?? (await skuMappings(db))).map((m) => [m.sku_key, m]));
  const params = [window.from, window.to];
  let only = "";
  if (customerIds) {
    params.push(customerIds);
    only = "AND c.id = ANY($3::int[])";
  }
  const { rows } = await db.query(
    `SELECT c.id AS customer_id, ${SKU_KEY_SQL("l")} AS sku_key, SUM(COALESCE(l.qty, 0))::float8 AS qty
       FROM erp_order_lines l JOIN customers c ON c.erp_customer_id = l.erp_customer_id
      WHERE l.order_date BETWEEN $1::date AND $2::date AND l.${NOT_INTERNAL} ${only}
      GROUP BY 1, 2`,
    params
  );
  const out = new Map();
  for (const r of rows) {
    const m = maps.get(r.sku_key);
    if (!out.has(r.customer_id)) out.set(r.customer_id, { by_line: {}, total: 0, unmapped: 0 });
    const a = out.get(r.customer_id);
    if (m?.status === "auto" || m?.status === "manual") {
      const l = (r.qty * m.litres_per_unit) / window.months;
      a.by_line[m.line_id] = (a.by_line[m.line_id] ?? 0) + l;
      if (!m.kg) a.total += l; // the total is litres: grease (kg) is shown on its own line only
    } else if ((!m || m.status === "unmapped") && !m?.kg) {
      a.unmapped += (r.qty * (m?.litres_per_unit ?? 0)) / window.months;
    }
  }
  for (const a of out.values()) {
    for (const k of Object.keys(a.by_line)) a.by_line[k] = Math.round(a.by_line[k] * 10) / 10;
    a.total = Math.round(a.total * 10) / 10;
    a.unmapped = Math.round(a.unmapped * 10) / 10;
  }
  return out;
}

// Share of wallet and gap for one customer (review, 2026-11-17: one meaning everywhere, bought + can still buy = potential):
//   potential = the total monthly need (else the lines' sum), litres only (grease kg lines are shown, never added to litres)
//   bought    = every placed product they buy from us, litres
//   gap       = potential - bought, never below 0; with a line filter, the gaps of those lines
//   per line  = { line_id, potential, actual, share_pct, gap, kg } -- where the gap is
export function walletOf({ lines = [], total_l = null }, actual = { by_line: {}, total: 0, unmapped: 0 }, { lineIds = null, kgLines = new Set() } = {}) {
  const pick = lineIds ? lines.filter((l) => lineIds.has(l.line_id)) : lines;
  const rows = pick
    .filter((l) => Number(l.amount) > 0)
    .map((l) => {
      const potential = Number(l.amount);
      const act = Number(actual.by_line?.[l.line_id] ?? 0);
      return { line_id: l.line_id, potential, actual: act, share_pct: Math.round((act / potential) * 100), gap: Math.max(0, Math.round((potential - act) * 10) / 10), kg: kgLines.has(l.line_id) };
    });
  // litres only, unless the filter picked kg lines only (then all in kg)
  const counted = rows.some((r) => !r.kg) ? rows.filter((r) => !r.kg) : rows;
  const lineSum = (k) => counted.reduce((s, r) => s + r[k], 0);
  const byLines = rows.length > 0;
  const potential = lineIds ? lineSum("potential") : Number(total_l) > 0 ? Number(total_l) : lineSum("potential");
  const act = lineIds ? lineSum("actual") : Number(actual.total ?? 0);
  const gap = lineIds ? lineSum("gap") : Math.max(0, potential - act);
  return {
    lines: rows,
    potential: Math.round(potential * 10) / 10,
    actual: Math.round(act * 10) / 10,
    gap: Math.round(gap * 10) / 10,
    share_pct: potential > 0 ? Math.round((act / potential) * 100) : null,
    by_lines: byLines,
  };
}

export async function kgLineIds(db = pool) {
  return new Set((await db.query("SELECT id FROM volume_potential_lines WHERE unit = 'kg'")).rows.map((r) => r.id));
}
