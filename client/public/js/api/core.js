// The request machinery behind the `api` object (../api.js): request(), json(), the short in-memory GET cache, prefetch, CSRF, timeouts,
// and the customer rules every customer read goes through (normalizeCustomer, competitors). Moved out of api.js in step 8a.
import { APP_VERSION } from "../version.js";
import { t } from "../i18n.js";

// The bottom-nav tabs (Dashboard/Activity/Customers/Orders) each re-fetch
// their list/summary data from scratch on every visit, showing a "Loading"
// placeholder until it resolves -- reported live as "loading every time"
// switching tabs on an iPhone, where cellular round-trips to these
// endpoints can run a couple of seconds each. A short-lived cache for just
// these list/summary GETs means a tab revisited within GET_CACHE_TTL_MS
// resolves from memory: since that happens on the microtask queue rather
// than a real network round trip, the browser never gets a paint
// opportunity between the view clearing to "Loading" and it filling back
// in with content, so the flash disappears for that revisit. Any
// non-GET request (the user actually changing something) clears the whole
// cache, so a check-in, order, or payment the user just submitted is never
// hidden behind stale cached data -- correctness always wins over the
// cache. Deliberately an allowlist of exact base paths (not "every GET"):
// endpoints this app polls for live data (team locations on the map,
// badge counts) need to stay genuinely live, not just "fresh within 20s".
export const GET_CACHE_TTL_MS = 20000;

export const GET_TIMEOUT_MS = 30000;

export const CACHEABLE_BASE_PATHS = new Set(["/dashboard/summary", "/dashboard/trends", "/settings", "/customers", "/checkins", "/orders", "/products"]);

export const getCache = new Map();

// Touch-down prefetch (see prefetch.js): the detail GET a tap is about to
// need is started when the finger lands, and the real request a moment later
// takes over that same in-flight promise. Single use and short-lived (a tap
// follows within a second or not at all), so nothing here can show stale
// data the way a general response cache could.
export const PREFETCH_TTL_MS = 8000;

export const prefetched = new Map();

export function prefetchGet(path) {
  const hit = prefetched.get(path);
  if (hit && hit.expires > Date.now()) return;
  const promise = doRequest(path, {});
  promise.catch(() => prefetched.delete(path));
  prefetched.set(path, { expires: Date.now() + PREFETCH_TTL_MS, promise });
}

// Two parts of one screen asking for the same GET at the same moment (the Home tab asked for its open tasks and the sync status twice) share
// one round trip. Only requests that are in flight at the same time are shared -- nothing is kept after the answer arrives.
export const inflightGets = new Map();

export function sharedGet(path, options) {
  const hit = inflightGets.get(path);
  if (hit) return hit;
  const promise = doRequest(path, options);
  inflightGets.set(path, promise);
  const done = () => inflightGets.get(path) === promise && inflightGets.delete(path);
  promise.then(done, done);
  return promise;
}

export async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET") {
    getCache.clear();
    prefetched.clear();
    inflightGets.clear(); // a GET sent after a change must not share an answer that left before it
    // Screens keeping their own copies (listCache.js, the customer card) drop answers that left before this change.
    window.dispatchEvent(new Event("fv:data-changed"));
    return doRequest(path, options);
  }
  // { fresh: true }: a screen that must show what is true NOW (the Orders list other people keep changing) skips both
  // short-lived caches below.
  if (options.fresh) return sharedGet(path, {});
  const hit = prefetched.get(path);
  if (hit) {
    prefetched.delete(path);
    if (hit.expires > Date.now()) return hit.promise;
  }
  if (CACHEABLE_BASE_PATHS.has(path.split("?")[0])) {
    const cached = getCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = sharedGet(path, options);
    getCache.set(path, { expires: Date.now() + GET_CACHE_TTL_MS, promise });
    promise.catch(() => getCache.delete(path));
    return promise;
  }
  return sharedGet(path, options);
}

// Double-submit-cookie CSRF token (see server/src/middleware/csrf.js) --
// the server sets this as a plain (non-httpOnly) cookie alongside the
// session cookie on login, specifically so this can read it back and echo
// it in a header the server then compares against its own cookie copy.
export function getCsrfToken() {
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Offline copies of reads (listCache.js saveOfflineCopy / readOfflineCopy; owner, 2026-11-07): a read that fails for lack of a connection
// (no network, or no answer within GET_TIMEOUT_MS) answers with its last saved copy, at most 3 days old, and the app says so
// ("fv:offline-copy" -> a note with the time of the copy, app.js). Never for a change (POST/PATCH/...), never for an answer the server
// refused (4xx/5xx), never for the live addresses below (who is where now, sign-in, counters, the sync's own state).
const NO_OFFLINE_COPY = /^\/(auth|me\b|csrf|lockdown|push|locations|team-locations|notifications|badges|client-errors|health|system-health|erp-sync\/status|version|tasks\/rewards)/;
const OFFLINE_SAVE_EVERY_MS = 60000;
const offlineSavedAt = new Map();
function keepOfflineCopy(path, body) {
  if (NO_OFFLINE_COPY.test(path) || body == null) return;
  const last = offlineSavedAt.get(path) ?? 0;
  if (Date.now() - last < OFFLINE_SAVE_EVERY_MS) return;
  offlineSavedAt.set(path, Date.now());
  if (offlineSavedAt.size > 500) offlineSavedAt.clear();
  let copy;
  try {
    copy = structuredClone(body); // now: the screen may sort or edit its rows before the store writes them
  } catch {
    return;
  }
  import("../listCache.js").then((m) => m.saveOfflineCopy(path, copy)).catch(() => {});
}
async function offlineCopy(path) {
  if (NO_OFFLINE_COPY.test(path)) return undefined;
  try {
    const stored = await (await import("../listCache.js")).readOfflineCopy(path);
    if (!stored) return undefined;
    window.dispatchEvent(new CustomEvent("fv:offline-copy", { detail: { at: stored.at } }));
    return stored.body;
  } catch {
    return undefined;
  }
}

const TASK_CLOSING_WRITES = /^\/(checkins|payments|orders|customers|products|cashflow)/;

export async function doRequest(path, options) {
  const method = (options.method || "GET").toUpperCase();
  const csrfToken = method !== "GET" ? getCsrfToken() : null;
  // A JSON string body without a Content-Type is silently ignored by the server's
  // express.json() (req.body stays empty): the credit limit and the manual Excel order
  // link both "saved" nothing that way. Default it here so no call can forget it.
  const jsonBody = typeof options.body === "string" && !options.headers?.["Content-Type"];
  // A read that has not answered in 30 s is given up (owner, 2026-10-26: a customer card spun forever): the screen gets an error it can show
  // with a Retry instead of an endless "Loading". Writes and uploads keep their own, longer patience.
  const controller = method === "GET" && !options.signal ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), GET_TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "include",
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        "X-App-Version": APP_VERSION,
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    clearTimeout(timer);
    // no connection / no answer: a read answers with its last saved copy when there is one
    if (method === "GET" && !options.signal) {
      const copy = await offlineCopy(path);
      if (copy !== undefined) return copy;
    }
    if (controller?.signal.aborted) {
      const timeout = new Error(t("request_timeout"));
      timeout.status = 408;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // A write that can finish a task by itself (a payment, an order, a check-in, a shop's products): the "well done" card looks right after.
  if (method !== "GET" && res.ok && TASK_CLOSING_WRITES.test(path)) window.dispatchEvent(new Event("fv:tasks-maybe-changed"));

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (method === "GET" && res.ok && isJson) keepOfflineCopy(path, body);

  if (!res.ok) {
    if (res.status === 423 && body?.locked) {
      // Emergency Disconnect just engaged (or was already on) -- take the
      // whole tab over immediately rather than letting whichever view
      // triggered this request quietly swallow it in its own try/catch
      // (most callers do), which would leave stale data on screen. Fires
      // for every in-flight request the same instant, but the overlay
      // itself is idempotent about being shown twice.
      import("../lockdownScreen.js").then((m) => m.showLockdownOverlay());
    }
    // 45 server routes answer a role check with the bare English "Not
    // allowed", which then showed as a red error line on whatever screen the
    // request came from (Warehouse, Reports, Recorded... reached by link or
    // bookmark). Say what it means, in the user's language. Specific 403
    // messages ("Only the recipient can confirm this handoff") are left alone.
    // An order refused for an out-of-stock product (server/src/orders/orderStock.js): name the products in the user's language.
    const message =
      body?.code === "out_of_stock" && Array.isArray(body.products)
        ? t("order_out_of_stock_error").replace("{names}", body.products.map((p) => p.name).join(", "))
        : body?.code === "short_stock" && Array.isArray(body.products)
        ? t("order_short_stock_error").replace("{items}", body.products.map((p) => `${p.name} (${t("order_short_stock_item").replace("{wanted}", p.wanted).replace("{left}", p.available)})`).join(", "))
        : res.status === 403 && (body?.message || body?.error) === "Not allowed"
          ? t("not_available_for_role")
          : body?.message || body?.error;
    const err = new Error(message || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function json(path, method, data) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function bankForm(file, accountId, mapping, { acceptMismatch = false } = {}) {
  const form = new FormData();
  form.set("file", file);
  if (accountId) form.set("account_id", String(accountId)); // no account = the statement's own account number decides
  if (mapping) form.set("mapping", JSON.stringify(mapping));
  if (acceptMismatch) form.set("accept_mismatch", "1");
  return form;
}

// Potential and Competitors are portfolio-level channels in filters, not
// operational routing values written into customers.sales_channel. Only
// stand in for a MISSING sales_channel -- a customer an SM has already
// assigned a real channel to (e.g. OEM, PCO) keeps showing that channel
// everywhere even before it's ERP-linked; erp_customer_id alone is not
// reason enough to hide it behind "Potential" (that used to happen here
// unconditionally, which is why the map's channel filter/pins only ever
// showed SM channels + Potential -- every not-yet-ERP-linked customer's
// real channel was being overwritten regardless of whether it had one).
// (was customerPortfolioUi.js, which replaced these four api methods from outside; docs/architecture-roadmap.md step 7b)
export function normalizeCustomer(customer) {
  if (!customer || typeof customer !== "object") return customer;
  const copy = { ...customer };
  if (copy.customer_tier === "competitor") {
    copy.sales_channel = "COMPETITORS";
  } else if (!String(copy.erp_customer_id ?? "").trim() && !String(copy.sales_channel ?? "").trim()) {
    copy.customer_tier = "potential";
    copy.sales_channel = "POTENTIAL";
  }
  return copy;
}

// Competitors are market-intelligence records, not customers to visit: never overdue, never in the "overdue" / "not visited"
// queues, never put on a visit plan (was competitorPolicySafe.js, which replaced these api methods from outside; step 7b).
export const competitorIds = new Set();

export function rememberCompetitors(rows) {
  for (const c of Array.isArray(rows) ? rows : rows ? [rows] : []) {
    if (c?.customer_tier === "competitor" && Number.isInteger(Number(c.id))) competitorIds.add(Number(c.id));
  }
}

export const stripCompetitorIds = (ids) => (Array.isArray(ids) ? ids.filter((id) => !competitorIds.has(Number(id))) : ids);

export const competitorNotDue = (c) => (c?.customer_tier === "competitor" ? { ...c, overdue: false, visit_required: false } : c);
