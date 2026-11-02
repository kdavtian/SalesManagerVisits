// Who paid a bank statement line (owner, 2026-11-02, pure -- no database): the answers the accountant gave before come first (a payer
// confirmed once is recorded on its own next time, or skipped as "not a customer"), then the customer's TIN written in the line, then a
// payer name equal to exactly one customer's name or legal name (owner's choice: also automatic). Anything else waits in "Unspecified".

const LEGAL_FORMS = new Set(["սպը", "փբը", "բբը", "աձ", "հկ", "հձ", "llc", "cjsc", "ojsc", "ltd", "inc", "pe", "ie", "ооо", "зао", "оао", "ао", "ип"]);

/** Lower case, quotes and punctuation gone, spaces collapsed ("ՍՊԸ «Ավտո Մաս»" -> "սպը ավտո մաս"). */
export function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ա\s*[/.]\s*ձ\.?/gu, " աձ ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The key of a payer name the accountant's answers are remembered by. Empty = nothing to remember. */
export const payerKey = (counterparty) => normText(counterparty).slice(0, 200);

/** A name without its legal form, for the exact-name rule ("Auto Mas LLC" = "ՍՊԸ Auto Mas" = "auto mas"). */
export function nameKey(s) {
  return normText(s)
    .split(" ")
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(" ");
}

/** 8-digit numbers in the text: Armenian TINs. */
export function findTins(text) {
  return [...new Set(String(text ?? "").match(/(?<!\d)\d{8}(?!\d)/g) ?? [])];
}

/**
 * Build the lookup once per run. customers: [{ id, tin, name, legal_name }]; rules: [{ payer_key, customer_id }] (customer_id null = not a customer).
 */
export function buildPayerIndex(customers, rules) {
  const byTin = new Map();
  const byName = new Map();
  const add = (map, key, id) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list);
  };
  for (const c of customers) {
    const tin = String(c.tin ?? "").replace(/\D/g, "");
    if (tin.length === 8) add(byTin, tin, c.id);
    // a name of one or two letters says nothing
    for (const n of [c.name, c.legal_name]) {
      const k = nameKey(n);
      if (k.length >= 3) add(byName, k, c.id);
    }
  }
  return { byTin, byName, rules: new Map(rules.map((r) => [r.payer_key, r.customer_id ?? null])) };
}

/**
 * line: { counterparty, description, reference }. Returns one of
 *   { customerId, how: 'learned' | 'tin' | 'name' }       recorded automatically
 *   { notCustomer: true, how: 'learned' }                   skipped (the accountant said so for this payer before)
 *   { customerId: null, reason: 'ambiguous', suggestion }   several customers fit: the accountant picks (the first is suggested)
 *   { customerId: null, reason: 'unknown_payer' }           nothing fits
 */
export function identifyPayer(line, index) {
  const key = payerKey(line.counterparty);
  if (key && index.rules.has(key)) {
    const id = index.rules.get(key);
    return id ? { customerId: id, how: "learned" } : { notCustomer: true, how: "learned" };
  }
  const text = [line.counterparty, line.description, line.reference].filter(Boolean).join(" ");
  const tinHits = [...new Set(findTins(text).flatMap((t) => index.byTin.get(t) ?? []))];
  if (tinHits.length === 1) return { customerId: tinHits[0], how: "tin" };
  if (tinHits.length > 1) return { customerId: null, reason: "ambiguous", suggestion: tinHits[0] };
  const nk = nameKey(line.counterparty);
  const nameHits = nk ? index.byName.get(nk) ?? [] : [];
  if (nameHits.length === 1) return { customerId: nameHits[0], how: "name" };
  if (nameHits.length > 1) return { customerId: null, reason: "ambiguous", suggestion: nameHits[0] };
  return { customerId: null, reason: "unknown_payer" };
}
