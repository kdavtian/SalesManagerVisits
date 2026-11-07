// Small pure helpers of the Purchases screen (tested in server/test/purchaseNumbers.test.js).

/**
 * The invoice number that follows `last` ("3/26" -> "4/26", "KAL 1/24" -> "KAL 2/24", "35" -> "36", "A-009" -> "A-010").
 * The first number in the text is the counter; the rest (the year after the slash, a prefix) stays. Nothing to count -> "".
 */
export function nextInvoiceNo(last) {
  const text = String(last ?? "").trim();
  const m = text.match(/\d+/);
  if (!m) return "";
  const next = String(Number(m[0]) + 1).padStart(m[0].length, "0");
  return text.slice(0, m.index) + next + text.slice(m.index + m[0].length);
}

/**
 * A typed amount: "385", "15,24", "1 250,50", "1,250.50" and "1.250,50" all read as a person means them; an empty box is null; text that
 * is not a number is NaN (never a silent 0 -- a price must not be saved as $0 because of a typo).
 */
export function parseAmount(value) {
  const text = String(value ?? "").replace(/[\s\u00a0]/g, "");
  if (text === "") return null;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let clean = text;
  if (lastComma >= 0 && lastDot >= 0) clean = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, ""); // the last mark is the decimal one
  else if (lastComma >= 0) clean = (text.match(/,/g) ?? []).length > 1 ? text.replace(/,/g, "") : text.replace(",", ".");
  return /^-?\d*\.?\d+$|^-?\d+\.$/.test(clean) ? Number(clean) : Number.NaN;
}

/** The change from the previous price to the new one, in whole percent (+3, -12); null when either is missing or the previous is 0. */
export function priceChangePct(previous, current) {
  const a = Number(previous);
  const b = Number(current);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return Math.round(((b - a) / a) * 100);
}

/** "How long ago" without a library: "12 min", "3 h", "5 d". The unit words come from the caller (translated), so the screen speaks Armenian. */
export function sinceText(iso, now, units) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} ${units.min}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} ${units.h}`;
  return `${Math.floor(h / 24)} ${units.d}`;
}
