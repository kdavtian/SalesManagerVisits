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

async function getCached(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(scopedKey(key));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // IndexedDB unavailable (private browsing, storage pressure) -- just
    // means no instant-open this time, not a reason to fail the screen.
    return undefined;
  }
}

async function setCached(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, scopedKey(key));
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
    const fresh = await fetcher();
    setCached(key, fresh);
    onData(fresh, { stale: false });
  } catch (err) {
    if (cached === undefined) throw err;
  }
}
