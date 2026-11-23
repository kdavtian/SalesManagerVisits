// The one "where is the cash now" mark (owner, 2026-11-23), drawn from the server's `cash_place` (shared/cashPlace.js): the same words
// and colours on the Payments list, the payment sheet, the customer's payments, the request card and the money ledger.
import { t } from "./i18n.js";
import { escapeHtml } from "./util.js";

// amber = still on its way to the office, green = the company has it, red = refused
const CLS = { with_rep: "badge-warning", on_the_way: "badge-info", with_director: "badge-warning", office: "badge-success", rejected: "badge-danger" };

export function cashPlaceText(place) {
  if (!place) return "";
  const text = t(place.direct ? "cash_place_received_by" : `cash_place_${place.place}`);
  return text.replace("{name}", place.name || "—").replace("{to}", place.to || "—");
}

export function cashPlaceChipHtml(place, { extraClass = "" } = {}) {
  if (!place) return "";
  const text = escapeHtml(cashPlaceText(place));
  return `<span class="badge cash-place-chip ${CLS[place.place] ?? "badge-neutral"}${extraClass ? ` ${extraClass}` : ""}" data-cash-place="${place.place}" title="${text}">${text}</span>`;
}
