// Looks a company up in the Armenian state register (e-register.moj.am) by
// its TIN (ՀՎՀՀ) and returns its legal name and legal address.
//
// IMPORTANT: written without being able to open the site from the dev
// environment, so it discovers the search form from the page itself and reads
// the result by its Armenian labels instead of hard-coding URLs/selectors.
// Everything site-specific lives in this one file (FIELD_LABELS, the form
// discovery); a lookup that can't read the page returns { found: false } and
// the app falls back to manual entry -- it never guesses values.
const BASE = "https://e-register.moj.am";
const SEARCH_URL = `${BASE}/hy/search/companies`;
const TIMEOUT_MS = 12000;

const NAME_LABELS = ["Կազմակերպության անվանում", "Անվանում", "Լրիվ անվանում", "Name"];
const ADDRESS_LABELS = ["Իրավաբանական հասցե", "Գտնվելու վայր", "Հասցե", "Address"];

export function isValidTin(tin) {
  return /^\d{8}$/.test(String(tin ?? "").trim());
}

function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|tr|li|h\d|dt|dd|th|td)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// "Label: value" or "Label\nvalue" -> value, trying labels in priority order.
export function extractByLabels(text, labels) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const label of labels) {
    const lower = label.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.toLowerCase().startsWith(lower)) continue;
      const rest = line.slice(label.length).replace(/^[\s:՝\-–]+/, "").trim();
      if (rest) return rest;
      if (lines[i + 1]) return lines[i + 1];
    }
  }
  return null;
}

export function parseCompanyText(html) {
  const text = textOf(html);
  return { legal_name: extractByLabels(text, NAME_LABELS), legal_address: extractByLabels(text, ADDRESS_LABELS) };
}

function findSearchForm(html) {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = form.exec(html))) {
    const open = m[0].match(/<form\b[^>]*>/i)[0];
    const inputs = [...m[1].matchAll(/<input\b[^>]*>/gi)].map((i) => i[0]);
    const field = inputs.find((i) => /name="([^"]*)"/i.test(i) && !/type="(hidden|submit|button)"/i.test(i));
    if (!field) continue;
    return {
      action: (open.match(/action="([^"]*)"/i)?.[1] || SEARCH_URL).replace(/&amp;/g, "&"),
      method: (open.match(/method="([^"]*)"/i)?.[1] || "get").toLowerCase(),
      field: field.match(/name="([^"]*)"/i)[1],
      hidden: Object.fromEntries(inputs.filter((i) => /type="hidden"/i.test(i)).map((i) => [i.match(/name="([^"]*)"/i)?.[1], i.match(/value="([^"]*)"/i)?.[1] ?? ""]).filter(([k]) => k)),
    };
  }
  return null;
}

async function get(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": "Mozilla/5.0 (FieldVisits)", "Accept-Language": "hy,en;q=0.8", ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Registry answered ${res.status}`);
  return res.text();
}

export async function lookupCompanyByTin(tin) {
  const value = String(tin ?? "").trim();
  if (!isValidTin(value)) return { found: false, reason: "invalid_tin" };
  try {
    const page = await get(SEARCH_URL);
    const form = findSearchForm(page);
    if (!form) return { found: false, reason: "layout_unknown" };
    const params = new URLSearchParams({ ...form.hidden, [form.field]: value });
    const target = new URL(form.action, SEARCH_URL).toString();
    const result =
      form.method === "post"
        ? await get(target, { method: "POST", body: params, headers: { "Content-Type": "application/x-www-form-urlencoded" } })
        : await get(`${target}${target.includes("?") ? "&" : "?"}${params}`);
    let parsed = parseCompanyText(result);
    // A result list usually links to the company's own page: follow the first
    // link that mentions the TIN or looks like a company detail page.
    if (!parsed.legal_name || !parsed.legal_address) {
      const link = [...result.matchAll(/<a\b[^>]*href="([^"#]+)"/gi)].map((l) => l[1]).find((h) => /compan|legal|detail|view|id=/i.test(h) && !/search/i.test(h));
      if (link) {
        const detail = parseCompanyText(await get(new URL(link.replace(/&amp;/g, "&"), BASE).toString()));
        parsed = { legal_name: parsed.legal_name || detail.legal_name, legal_address: parsed.legal_address || detail.legal_address };
      }
    }
    if (!parsed.legal_name && !parsed.legal_address) return { found: false, reason: "not_found_or_unreadable" };
    return { found: true, ...parsed };
  } catch (err) {
    return { found: false, reason: "unreachable", detail: err.message };
  }
}
