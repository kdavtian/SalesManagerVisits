// Everything one customer card shows, fetched as ONE bundle and kept on the phone (listCache.js) so that:
//  - a finger landing on a customer row / name starts the whole load before the tap completes (warmCustomerCard, called from prefetch.js);
//  - a card that was opened before shows instantly from the saved copy while a fresh one is fetched (customerDetail.js).
// The small extras (social icons, documents, tasks, "End visit") ride in the same bundle so the card draws once, complete. An extra slower than
// SOON_MS does not hold the card back: it is `undefined` in the bundle and its promise is in `lateParts`, which the card fills in from.
import { api } from "./api.js";
import { state } from "./state.js";
import { fetchCustomerSocial } from "./customerSocialProfiles.js";
import { warmCache } from "./listCache.js";

// The card shows this many latest visits at once; older ones load when the rep asks (a long-standing customer has hundreds).
export const VISITS_PAGE = 30;
const SOON_MS = 1200;
// A row passed under the finger (or the mouse) again within this time is not fetched twice.
const WARM_AGAIN_MS = 15_000;

// When each card was last fetched: a card opened right after the finger-down fetch finished is not fetched a second time to "revalidate".
const fetchedAt = new Map();
export const fetchedJustNow = (id) => Date.now() - (fetchedAt.get(String(id)) || 0) < 8000;

export const cardSource = (id) => ({ key: `cust-card:${id}`, fetch: () => fetchCard(id) });

// customer id -> { social, docs, tasks, openVisit } promises of the parts that were not there within SOON_MS. Not saved to the phone.
export const lateParts = new Map();

// After any change sent to the server the next open revalidates (End visit, a new task, a file...), and a logout forgets everything.
window.addEventListener("fv:data-changed", () => {
  fetchedAt.clear();
  warmedAt.clear();
});
window.addEventListener("fv:cache-cleared", () => {
  fetchedAt.clear();
  warmedAt.clear();
  lateParts.clear();
});

const soon = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, SOON_MS))]);

async function fetchCard(id) {
  let partialFailure = false;
  // The card opens as soon as the customer itself is there; the visit list, the pending edit requests and the Excel orders are parts of the
  // page: when one fails the page still opens, with a "could not load everything" line and a retry.
  const optional = (promise, fallback) =>
    promise.catch(() => {
      partialFailure = true;
      return fallback;
    });
  const socialP = fetchCustomerSocial(id).catch(() => null);
  const docsP = api.listCustomerDocuments(id).catch(() => null);
  const tasksP = api.listTasks({ scope: "all", status: "open", customer_id: id }).catch(() => ({ rows: [], today: "" }));
  const openVisitP = state.user?.role === "sales_manager" ? api.getOpenVisit(id).catch(() => null) : Promise.resolve(null);
  // The code that draws the tasks and documents blocks is loaded while the data is, not after it.
  import("./views/tasks.js").catch(() => {});
  import("./accountingFiles.js").catch(() => {});
  const [customer, checkins, pendingRequests, erpOrders, brandSummaryRows, visitSchedule, social, docs, tasks, openVisit] = await Promise.all([
    api.getCustomer(id),
    optional(api.customerCheckins(id, { limit: VISITS_PAGE }), []),
    optional(api.listEditRequests({ customer_id: id, status: "pending" }), []),
    optional(api.getErpOrders(id, "recent"), []),
    // Optional extras: a failure here must not break the customer page.
    api.getBrandSummary({ customer_id: id }).catch(() => []),
    api.getVisitSchedule(id).catch(() => null),
    soon(socialP),
    soon(docsP),
    soon(tasksP),
    soon(openVisitP),
  ]);
  fetchedAt.set(String(id), Date.now());
  const bundle = { customer, checkins, pendingRequests, erpOrders, brandSummaryRows, visitSchedule, social, docs, tasks, openVisit, partialFailure };
  const slow = {};
  if (social === undefined) slow.social = socialP;
  if (docs === undefined) slow.docs = docsP;
  if (tasks === undefined) slow.tasks = tasksP;
  if (openVisit === undefined) slow.openVisit = openVisitP;
  if (Object.keys(slow).length) lateParts.set(String(id), slow);
  else lateParts.delete(String(id));
  return bundle;
}

// A copy that is missing parts must not be shown as if it were whole: the next open fetches again instead.
export const isWholeBundle = (b, id) =>
  Boolean(b && b.customer && String(b.customer.id) === String(id) && !b.partialFailure && b.social !== undefined && b.docs !== undefined && b.tasks !== undefined && b.openVisit !== undefined);

// Starts loading a card (no-op when it was started a moment ago or is already on its way). Never throws.
const warmedAt = new Map();
export function warmCustomerCard(id) {
  if (!state.user || !/^\d+$/.test(String(id))) return;
  const last = warmedAt.get(String(id));
  if (last && Date.now() - last < WARM_AGAIN_MS) return;
  warmedAt.set(String(id), Date.now());
  const source = cardSource(id);
  warmCache(source.key, source.fetch);
}
