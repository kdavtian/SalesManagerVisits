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
const DB_NAME = "fieldvisits_list_cache";
const STORE = "responses";
let dbPromise = null;

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
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
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
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Best-effort cache write; losing it only costs the next instant-open.
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
