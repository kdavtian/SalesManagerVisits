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
    if (controller?.signal.aborted) {
      const timeout = new Error(t("request_timeout"));
      timeout.status = 408;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return null;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

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

export function bankForm(file, accountId, mapping) {
  const form = new FormData();
  form.set("file", file);
  form.set("account_id", String(accountId));
  if (mapping) form.set("mapping", JSON.stringify(mapping));
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
