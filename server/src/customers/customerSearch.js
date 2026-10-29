// Customer search on the server, in both scripts with one typo allowed in words of 5+ letters (shared/searchKey.js; owner,
// 2026-10-29): the Customers list, the desktop top-bar search and the Orders search find "Ջրվեժ" from "jrvej".
import { pool } from "../db/pool.js";
import { foldText, matchKind, prepareSearchText } from "../shared/searchKey.js";

// The ids of every customer matching `search`, best match first (as typed, then the other script, then one letter off). The prepared
// search text of each customer is kept between searches and made again only when its fields change.
const preparedCustomers = new Map(); // id -> { text, prepared }
export async function customerIdsMatching(search) {
  const { rows } = await pool.query(
    `SELECT id, phone, concat_ws(' ', name, erp_customer_id, tin, legal_name, address, region, subregion, instagram_username, facebook_url, email, website) AS text
     FROM customers`
  );
  const words = foldText(search).split(/\s+/).filter(Boolean).slice(0, 8);
  const hits = [];
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    let entry = preparedCustomers.get(r.id);
    if (!entry || entry.text !== r.text) {
      entry = { text: r.text, prepared: prepareSearchText(r.text) };
      preparedCustomers.set(r.id, entry);
    }
    const phone = String(r.phone ?? "").replace(/\D/g, "").replace(/^374/, "").replace(/^0+/, "");
    let kind = 3;
    for (const w of words) {
      const k = matchKind(entry.prepared, w.replace(/^@/, ""));
      if (k) {
        kind = Math.min(kind, k);
        continue;
      }
      const digits = w.replace(/\D/g, "").replace(/^374/, "").replace(/^0+/, "");
      if (!(digits.length >= 3 && phone.includes(digits))) {
        kind = 0;
        break;
      }
    }
    if (kind) hits.push({ id: r.id, kind });
  }
  for (const id of preparedCustomers.keys()) if (!seen.has(id)) preparedCustomers.delete(id); // deleted customers
  return hits.sort((a, b) => b.kind - a.kind).map((h) => h.id);
}
