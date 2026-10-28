// Stale-while-revalidate for list/summary screens: render whatever was
// last successfully fetched for a given key immediately (even if it's a
// few minutes old), then fetch fresh data in the background and re-render
// when it lands. A screen that already has data never has to sit on a
// loading spinner while a network round-trip that will probably return
// the same rows finishes -- it shows something instantly and quietly
// corrects itself.
//
// Backed by IndexedDB (not localStorage) since a customer/orders list can
// run well past what localStorage's synchronous ~5-10MB budget comfortably
// holds, and this module already needs to be async either way.
import { state } from "./state.js";

const DB_NAME = "fieldvisits_list_cache";
const STORE = "responses";
let dbPromise = null;

// Every stored key is scoped to the signed-in user -- this store isn't
// cleared on logout (an entry losing its instant-open on the next login is
// a worse tradeoff than wiping every screen's cache on every logout), so
// without this a second rep signing into the same device would see the
// first rep's cached orders/customers/activity flash on screen before the
// real fetch overwrote it (reported as "another user's orders can
// appear"). clearListCache() below is still called on logout as
// defense-in-depth, not a substitute for this.
function scopedKey(key) {
  return `${state.user?.id ?? "anon"}:${key}`;
}

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// The most recently used copies also live in memory: reading IndexedDB takes a few milliseconds to tens of them, long enough for a screen
// to paint its "Loading..." line before the saved copy arrives -- the flash on a tab switch the owner dislikes. A copy found here is
// handed over in the same task, before the next paint. Copies are cloned in and out so a screen that sorts or edits its rows in place can
// never change what the next screen is given.
const MEMORY_MAX = 60;
const memory = new Map();
function memoryGet(full) {
  if (!memory.has(full)) return undefined;
  const value = memory.get(full);
  memory.delete(full); // most recently used last
  memory.set(full, value);
  return value;
}
function memorySet(full, value) {
  memory.delete(full);
  if (value !== undefined) memory.set(full, value);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
}
function cloneValue(value) {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

async function getCached(key) {
  const inMemory = memoryGet(scopedKey(key));
  if (inMemory !== undefined) {
    const copy = cloneValue(inMemory);
    if (copy !== undefined) return copy;
  }
  try {
    const db = await openDb();
    const stored = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(scopedKey(key));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (stored !== undefined) memorySet(scopedKey(key), stored);
    return stored === undefined ? undefined : cloneValue(stored); // the memory copy stays untouched by a screen that sorts its rows
  } catch {
    // IndexedDB unavailable (private browsing, storage pressure) -- just
    // means no instant-open this time, not a reason to fail the screen.
    return undefined;
  }
}

// `full` is the already-scoped key: an answer that lands after a logout + another login is not filed under the new person's name.
async function setCachedFull(full, value) {
  const copy = cloneValue(value);
  if (copy !== undefined) memorySet(full, copy);
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, full);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Best-effort cache write; losing it only costs the next instant-open.
  }
}

// Called on logout, alongside scopedKey() above -- belt and suspenders
// against a shared device ever showing one rep's cached list data to the
// next rep who signs in, in case some key is ever cached without going
// through getCached/setCached's own scoping.
export async function clearListCache() {
  memory.clear();
  inflight.clear(); // requests still on their way are not saved
  window.dispatchEvent(new Event("fv:cache-cleared"));
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Nothing to clean up if IndexedDB never opened in the first place.
  }
}

const LAST_ROLE_KEY_PREFIX = "fieldvisits_last_role:";

// scopedKey() above already stops one *account* from ever seeing another's
// cached data, but the same account's own cache can still go stale in a
// way that's a permissions problem, not just a freshness one: if an admin
// promotes/demotes this user (sales_manager <-> sales_director, say) while
// they're still signed in, their next app load re-authenticates fine, but
// a stale cached page (the deliberate stale:true instant-open in
// loadWithCache) could still flash data scoped to their OLD role's
// visibility for a moment before the real fetch corrects it. Call this
// right after every successful api.me()/login with the freshly-returned
// user -- it wipes the cache the one time it actually detects a role
// change for this account, and is a no-op every other time (same role as
// last time, or the very first time this account is ever seen here).
export async function clearCacheIfRoleChanged(user) {
  if (!user?.id || !user?.role) return;
  const storageKey = `${LAST_ROLE_KEY_PREFIX}${user.id}`;
  let lastRole;
  try {
    lastRole = localStorage.getItem(storageKey);
  } catch {
    return; // localStorage unavailable -- nothing to compare against safely.
  }
  if (lastRole && lastRole !== user.role) await clearListCache();
  try {
    localStorage.setItem(storageKey, user.role);
  } catch {
    // Best-effort; losing this just means the next role change isn't caught.
  }
}

// One request per key at a time: a "warm it as the finger lands" fetch and the sheet that opens a moment later share the same
// round trip instead of asking the server twice.
const inflight = new Map();
// { force: true } (the card right after the rep changed something) starts a new request instead of joining one that left before the change.
// Only the newest request for a key saves its answer, so an older one landing late never overwrites it.
function sharedFetch(key, fetcher, { force = false } = {}) {
  const full = scopedKey(key);
  if (force || !inflight.has(full)) {
    const promise = fetcher()
      .then((fresh) => {
        if (inflight.get(full) === promise) setCachedFull(full, fresh);
        return fresh;
      })
      .finally(() => inflight.get(full) === promise && inflight.delete(full));
    inflight.set(full, promise);
  }
  return inflight.get(full);
}
// Any change sent to the server: answers already on their way may predate it, so they are no longer shared or saved.
window.addEventListener("fv:data-changed", () => inflight.clear());

// For screens that want to decide for themselves what to do with a saved copy (the customer card): the copy, or undefined.
export const peekCache = getCached;
// The one shared request for a key (see sharedFetch); the result is saved as the key's copy.
export const refreshCache = sharedFetch;

// Fetch in the background so the next loadWithCache(key) of this key opens instantly. Never throws.
export function warmCache(key, fetcher) {
  return sharedFetch(key, fetcher).catch(() => {});
}

// key: a string unique to this screen + whatever params it was fetched
// with (e.g. "orders-list:status=confirmed") -- different filter/search
// state must not show stale data from a different filter.
// fetcher: () => Promise<data>, the real network call (an api.js method).
// onData(data, { stale }): called once synchronously-ish with cached data
// if any exists (stale: true), then again once the network responds
// (stale: false). If there was no cached data, onData is only called once,
// with the fresh result -- exactly like calling fetcher().then(onData)
// today, so a first-ever visit to a screen behaves the same as before.
//
// Network failure with a cached copy already shown is swallowed (the
// screen just keeps showing what it has -- useful offline, not just for
// speed); network failure with nothing cached rethrows so the caller's
// own .catch()/error state still fires like it always has.
export async function loadWithCache(key, fetcher, onData) {
  const cached = await getCached(key);
  if (cached !== undefined) onData(cached, { stale: true });
  try {
    const fresh = await sharedFetch(key, fetcher);
    onData(fresh, { stale: false });
  } catch (err) {
    if (cached === undefined) throw err;
  }
}

// Customer edits must show on the Customers list the moment the rep goes
// back to it -- not after the stale cached copy has been painted first and
// the network refetch finally lands. These patch the cached lists in place
// (or drop them when the change can't be applied locally, e.g. a new
// customer), so the instant-open copy is already correct.
// "map-customers" is the Map tab's own stale-while-revalidate copy: without it a new customer was missing, and a
// relocated one still sat at its OLD spot, on the Map's first paint until the live fetch landed (or for good when
// it was slow / offline).
const CUSTOMER_LIST_KEYS = ["customers-list:plain", "customers-list:with-debt", "map-customers"];

async function mutateCachedCustomerLists(mutate) {
  try {
    const db = await openDb();
    for (const key of CUSTOMER_LIST_KEYS) {
      const full = scopedKey(key);
      const current = await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(full);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!Array.isArray(current)) continue;
      const next = mutate(current);
      memorySet(full, next === null ? undefined : cloneValue(next));
      await new Promise((resolve, reject) => {
        const store = db.transaction(STORE, "readwrite").objectStore(STORE);
        const req = next === null ? store.delete(full) : store.put(next, full);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  } catch {
    // Best-effort: worst case the list shows the old copy until its refetch lands.
  }
}

export function patchCachedCustomer(id, fields) {
  return mutateCachedCustomerLists((list) =>
    list.map((c) => (String(c.id) === String(id) ? { ...c, ...fields } : c))
  );
}

export function removeCachedCustomer(id) {
  return mutateCachedCustomerLists((list) => list.filter((c) => String(c.id) !== String(id)));
}

export function dropCachedCustomerLists() {
  return mutateCachedCustomerLists(() => null);
}
