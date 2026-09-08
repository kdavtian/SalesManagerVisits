import { api } from "./api.js";

// Fourth of the audit-driven perf batch: this used to be pure localStorage
// -- the whole queue (photos included, base64-encoded) JSON.stringify'd and
// written back on every single mutation, synchronously blocking the main
// thread, and flushQueue() did that once per submission inside its own
// loop. localStorage also caps out around 5-10MB, easy to hit for a rep
// queuing several check-ins with the high-res photo option on while
// offline. IndexedDB is async (no main-thread blocking), has a far higher
// quota, and can store Blobs natively (no base64 bloat/CPU cost at all).
//
// getQueue()/onQueueChange() are called synchronously by existing callers
// (app.js's renderSyncBanner, settings.js's paintSyncStatus) and IndexedDB
// has no synchronous read API, so memoryQueue is the single source of
// truth for reads -- every mutation updates it and the DB together, and
// every exported function keeps its original signature/call shape so no
// caller needed to change.
const QUEUE_KEY = "fieldvisits_pending_checkins"; // legacy localStorage key; also this module's fallback store if IndexedDB is unavailable
const LAST_SYNC_KEY = "fieldvisits_last_synced_at";
const DB_NAME = "fieldvisits_offline";
const DB_STORE = "queue";

const listeners = new Set();
let memoryQueue = [];
let useIndexedDb = "indexedDB" in window;
let dbInstance = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, entry) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function notify() {
  listeners.forEach((fn) => fn(memoryQueue));
}

// Resolves once memoryQueue reflects whatever was already durably queued
// (from IndexedDB, or the localStorage fallback) -- every mutating export
// below awaits this first so it's never racing the initial load.
const ready = (async () => {
  if (useIndexedDb) {
    try {
      dbInstance = await openDb();
      memoryQueue = (await idbGetAll(dbInstance)).sort((a, b) => a.createdAt - b.createdAt);
      // One-time migration: a check-in queued by a client running before
      // this change (pure localStorage) would otherwise just vanish --
      // pull it into IndexedDB once, then clear the old key.
      const legacyRaw = localStorage.getItem(QUEUE_KEY);
      if (legacyRaw) {
        const legacyQueue = JSON.parse(legacyRaw);
        for (const entry of legacyQueue) {
          if (memoryQueue.some((e) => e.id === entry.id)) continue;
          await idbPut(dbInstance, entry);
          memoryQueue.push(entry);
        }
        localStorage.removeItem(QUEUE_KEY);
        memoryQueue.sort((a, b) => a.createdAt - b.createdAt);
      }
    } catch {
      // IndexedDB failed to open (private-browsing lockdown, storage
      // pressure, etc.) -- fall back to the old localStorage path rather
      // than losing the ability to queue offline work at all.
      useIndexedDb = false;
      dbInstance = null;
    }
  }
  if (!useIndexedDb) {
    try {
      memoryQueue = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch {
      memoryQueue = [];
    }
  }
  notify();
})();

async function persistNewEntry(entry) {
  if (useIndexedDb && dbInstance) {
    await idbPut(dbInstance, entry);
  } else {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(memoryQueue));
  }
}

async function removeEntry(id) {
  if (useIndexedDb && dbInstance) {
    await idbDelete(dbInstance, id);
  } else {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(memoryQueue));
  }
}

export function getQueue() {
  return memoryQueue;
}

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function enqueueCheckin(entry) {
  await ready;
  const record = { id: crypto.randomUUID(), createdAt: Date.now(), type: "checkin", ...entry };
  memoryQueue = [...memoryQueue, record];
  await persistNewEntry(record);
  notify();
}

// A rep often places an order right after a checkin, in the same weak-signal
// spot -- queue it the same way instead of losing the order entirely.
export async function enqueueOrder(entry) {
  await ready;
  const record = { id: crypto.randomUUID(), createdAt: Date.now(), type: "order", ...entry };
  memoryQueue = [...memoryQueue, record];
  await persistNewEntry(record);
  notify();
}

async function submitCheckin(entry) {
  const form = new FormData();
  form.set("customer_id", entry.customerId);
  form.set("lat", entry.lat);
  form.set("lng", entry.lng);
  if (entry.note) form.set("note", entry.note);
  if (entry.brandStatus && Object.keys(entry.brandStatus).length) form.set("brand_status", JSON.stringify(entry.brandStatus));
  if (entry.outcomes?.length) form.set("outcomes", JSON.stringify(entry.outcomes));
  if (entry.amountCollected != null) form.set("amount_collected_amd", entry.amountCollected);
  if (entry.availableProducts?.length) form.set("available_products", JSON.stringify(entry.availableProducts));
  // Entries queued since this change carry real Blobs (IndexedDB stores
  // them natively -- no base64 round trip needed); an entry migrated in
  // from a pre-IndexedDB localStorage queue still carries the old
  // photoDataUrls shape, so both are handled here.
  if (entry.photos?.length) {
    entry.photos.forEach((blob, i) => form.append("photos", blob, `checkin-${i}.jpg`));
  } else {
    for (const [i, dataUrl] of (entry.photoDataUrls ?? []).entries()) {
      const blob = await (await fetch(dataUrl)).blob();
      form.append("photos", blob, `checkin-${i}.jpg`);
    }
  }
  return api.createCheckin(form);
}

function submitOrder(entry) {
  return api.createOrder({
    customer_id: entry.customerId,
    checkin_id: entry.checkinId,
    items: entry.items,
    discount_pct: entry.discount_pct,
    discount_amd: entry.discount_amd,
    payment_method: entry.payment_method,
  });
}

// Entries queued before this file learned about "order" (type undefined)
// are always checkins -- keeps an already-queued entry on an old client
// submitting correctly after a deploy.
function submitEntry(entry) {
  return entry.type === "order" ? submitOrder(entry) : submitCheckin(entry);
}

let flushing = false;

export function getLastSyncedAt() {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  return raw ? Number(raw) : null;
}

export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    await ready;
    for (const entry of [...memoryQueue]) {
      try {
        await submitEntry(entry);
        memoryQueue = memoryQueue.filter((e) => e.id !== entry.id);
        await removeEntry(entry.id);
        notify();
      } catch (err) {
        if (err instanceof TypeError) {
          // Network-level failure (offline) — stop and retry later.
          break;
        }
        // Server rejected the entry (e.g. customer deleted) — drop it, don't retry forever.
        memoryQueue = memoryQueue.filter((e) => e.id !== entry.id);
        await removeEntry(entry.id);
        notify();
      }
    }
    if (!memoryQueue.length) localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } finally {
    flushing = false;
  }
}

window.addEventListener("online", flushQueue);
