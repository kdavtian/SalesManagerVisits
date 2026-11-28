import { api } from "./api.js";
import { QUEUE_SEND_TIMEOUT_MS } from "./api/core.js";
import { state } from "./state.js";
import { t } from "./i18n.js";

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

// Whose work it is (Phase 0 item 0.1, owner 2026-11-28): every entry remembers the user who saved it, and only that user's entries are shown
// and sent -- after another person signs in on the same phone, the first person's visits, orders and payments wait for them instead of being
// sent under the wrong login. An entry saved by an app version from before this rule has no owner: it is treated as the signed-in user's, as
// before, and the first send pass claims it for that person (flushQueue).
const currentUserId = () => state.user?.id ?? null;
const isMine = (entry) => currentUserId() != null && (entry.userId == null || entry.userId === currentUserId());
const stamp = (record) => ({ ...record, userId: currentUserId() });

function notify() {
  const mine = getQueue();
  listeners.forEach((fn) => fn(mine));
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

// Persists an entry already updated in-place in memoryQueue (e.g. a bumped
// attempts count) -- same idea as persistNewEntry, just an overwrite of an
// existing id instead of a first insert.
async function persistEntry(entry) {
  if (useIndexedDb && dbInstance) {
    await idbPut(dbInstance, entry);
  } else {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(memoryQueue));
  }
}

// The signed-in user's waiting entries only (see isMine); nobody signed in: none.
export function getQueue() {
  return memoryQueue.filter(isMine);
}

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function enqueueCheckin(entry) {
  await ready;
  const record = stamp({ id: crypto.randomUUID(), createdAt: Date.now(), type: "checkin", ...entry });
  memoryQueue = [...memoryQueue, record];
  await persistNewEntry(record);
  notify();
}

// A rep often places an order right after a checkin, in the same weak-signal
// spot -- queue it the same way instead of losing the order entirely.
export async function enqueueOrder(entry) {
  await ready;
  const record = stamp({ id: crypto.randomUUID(), createdAt: Date.now(), type: "order", ...entry });
  memoryQueue = [...memoryQueue, record];
  await persistNewEntry(record);
  notify();
}

// A stock count typed without signal (owner, 2026-10-30: "implement optimization idea 2"). One entry per product and day: typing the same
// product again replaces the waiting one. The server saves it on the day it was counted (server/src/orders/routes/stockCount.js).
export async function enqueueStockCount(entry) {
  await ready;
  const stale = memoryQueue.filter((e) => isMine(e) && e.type === "stock_count" && e.productId === entry.productId && e.day === entry.day);
  for (const e of stale) await removeEntry(e.id);
  const record = stamp({ id: crypto.randomUUID(), createdAt: Date.now(), type: "stock_count", ...entry });
  memoryQueue = [...memoryQueue.filter((e) => !stale.includes(e)), record];
  await persistNewEntry(record);
  notify();
}

// A customer's volume potential saved without signal (owner, 2026-11-17): one waiting save per customer (a newer one replaces it); the
// server keeps the save once even when it arrives twice (client_ref).
export async function enqueueVolumePotential(entry) {
  await ready;
  const stale = memoryQueue.filter((e) => isMine(e) && e.type === "volume_potential" && e.customerId === entry.customerId);
  for (const e of stale) await removeEntry(e.id);
  const record = stamp({ id: crypto.randomUUID(), createdAt: Date.now(), type: "volume_potential", ...entry });
  memoryQueue = [...memoryQueue.filter((e) => !stale.includes(e)), record];
  await persistNewEntry(record);
  notify();
}

// A payment typed in the Payments "+" sheet without signal (payments redesign, release 3b, owner 2026-11-02): it waits here with the
// customer's proof (slip photos, signature) and is sent as soon as the phone is online again. client_ref makes a retry harmless.
// The photos and signatures are kept as plain bytes, not Blobs: Safari refuses a Blob in IndexedDB in some states (a private window,
// older iOS), and the payment must never be lost for that.
const toBytes = async (blob) => (!blob ? null : blob instanceof Blob ? { bytes: await blob.arrayBuffer(), type: blob.type || "image/jpeg" } : blob);
// read a photo / signature into memory at once (while the phone still has it at hand): later, without signal, Safari may refuse to read it
export { toBytes as fileBytes };
const toBlob = (v) => (!v ? null : v instanceof Blob ? v : new Blob([v.bytes], { type: v.type }));

export async function enqueuePayment(entry) {
  await ready;
  const stored = {
    ...entry,
    slipPhotos: await Promise.all((entry.slipPhotos ?? []).map(toBytes)),
    customerSignature: await toBytes(entry.customerSignature),
    repSignature: await toBytes(entry.repSignature),
  };
  const record = stamp({ id: crypto.randomUUID(), createdAt: Date.now(), type: "payment", ...stored });
  memoryQueue = [...memoryQueue, record];
  await persistNewEntry(record);
  notify();
}

export function paymentForm(entry) {
  const form = new FormData();
  form.set("customer_id", entry.customerId);
  form.set("amount", entry.amount); // the server reads "amount" as amount_amd (routes/payments.js)
  if (entry.paymentDate) form.set("payment_date", entry.paymentDate);
  if (entry.note) form.set("note", entry.note);
  if (entry.salesManagerId) form.set("sales_manager_id", entry.salesManagerId);
  form.set("client_ref", entry.clientRef || entry.id);
  // the person saved it knowing it: a background retry cannot ask "is this a duplicate?" again
  if (entry.confirmDuplicate) form.set("confirm_duplicate", "true");
  entry.slipPhotos?.forEach((photo, i) => form.append("payment_slip_photos", toBlob(photo), `payment-slip-${i}.jpg`));
  if (entry.customerSignature) form.append("customer_signature", toBlob(entry.customerSignature), "customer-signature.png");
  if (entry.repSignature) form.append("rep_signature", toBlob(entry.repSignature), "rep-signature.png");
  return form;
}

// A send from the queue runs in the background: it may take longer than a save the rep waits for (core.js QUEUE_SEND_TIMEOUT_MS), but never
// for ever -- a hung send would hold the whole queue.
const SEND_OPTS = { saveTimeoutMs: QUEUE_SEND_TIMEOUT_MS };

async function submitCheckin(entry) {
  const form = new FormData();
  form.set("customer_id", entry.customerId);
  form.set("lat", entry.lat);
  form.set("lng", entry.lng);
  if (entry.accuracy != null) form.set("accuracy_m", entry.accuracy);
  // entry.clientRef, when the caller generated one before its own first
  // (online) attempt, ties this queued retry back to that same attempt --
  // whichever one the server actually saved wins, the other is recognized
  // as a duplicate. Falls back to entry.id (stable across retries of this
  // queued entry either way) for an entry queued by an older client build
  // that never set clientRef. See server/src/routes/checkins.js.
  form.set("client_ref", entry.clientRef || entry.id);
  // When the rep pressed submit, not when this retry finally got through (the
  // fuel report orders the day's visits by it).
  if (entry.createdAt) form.set("captured_at", new Date(entry.createdAt).toISOString());
  if (entry.note) form.set("note", entry.note);
  if (entry.brandStatus && Object.keys(entry.brandStatus).length) form.set("brand_status", JSON.stringify(entry.brandStatus));
  if (entry.competitorPrices?.length) form.set("competitor_prices", JSON.stringify(entry.competitorPrices));
  if (entry.outcomes?.length) form.set("outcomes", JSON.stringify(entry.outcomes));
  if (entry.noOrderReason) form.set("no_order_reason", entry.noOrderReason);
  if (entry.amountCollected != null) form.set("amount_collected_amd", entry.amountCollected);
  if (entry.availableProducts?.length) form.set("available_products", JSON.stringify(entry.availableProducts));
  // the shop's monthly oil need written at the visit (Sales Expert funnel)
  if (entry.expectedVolumeL != null && entry.expectedVolumeL !== "") form.set("expected_volume_l", entry.expectedVolumeL);
  if (entry.deliveredOrderIds?.length) form.set("delivered_order_ids", JSON.stringify(entry.deliveredOrderIds));
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
  // The signed order blank of a delivery ("Products delivered"), when the rep photographed it.
  entry.orderBlankPhotos?.forEach((blob, i) => form.append("order_blank_photos", blob, `order-blank-${i}.jpg`));
  // The customer's electronic signature (and the rep's own, when it was not on their profile yet): signed offline, the PDFs are made on the server
  // as soon as the phone is online again.
  entry.paymentSlipPhotos?.forEach((blob, i) => form.append("payment_slip_photos", blob, `payment-slip-${i}.jpg`));
  if (entry.customerSignature) form.append("customer_signature", entry.customerSignature, "customer-signature.png");
  if (entry.repSignature) form.append("rep_signature", entry.repSignature, "rep-signature.png");
  // the visit's voice note (owner, 2026-11-12) waits here with the photos
  const v = entry.voiceNote;
  const voiceBlob = v?.blob instanceof Blob ? v.blob : v?.bytes?.bytes ? toBlob(v.bytes) : null; // bytes (fileBytes) or a Blob, never a lost {}
  if (voiceBlob) {
    const ext = v.mime === "audio/mp4" ? "m4a" : v.mime === "audio/ogg" ? "ogg" : "webm";
    form.append("voice_note", voiceBlob, `voice-note.${ext}`);
    if (entry.voiceNote.durationS) form.set("voice_duration_s", entry.voiceNote.durationS);
  }
  return api.createCheckin(form, SEND_OPTS);
}

function submitOrder(entry) {
  // Same client_ref idempotency as submitCheckin above. See
  // server/src/routes/orders.js.
  return api.createOrder({
    customer_id: entry.customerId,
    checkin_id: entry.checkinId,
    items: entry.items,
    discount_pct: entry.discount_pct,
    discount_amd: entry.discount_amd,
    payment_method: entry.payment_method,
    payment_term_days: entry.payment_term_days,
    downpayment_pct: entry.downpayment_pct,
    downpayment_amd: entry.downpayment_amd,
    metrics: entry.metrics,
    client_ref: entry.clientRef || entry.id,
  }, SEND_OPTS);
}

// Entries queued before this file learned about "order" (type undefined)
// are always checkins -- keeps an already-queued entry on an old client
// submitting correctly after a deploy.
function submitEntry(entry) {
  if (entry.type === "stock_count") return api.saveStockCount(entry.productId, entry.qty, null, entry.day, SEND_OPTS);
  if (entry.type === "volume_potential") return api.saveVolumePotential(entry.customerId, entry.body, SEND_OPTS);
  // confirmDuplicate: a payment queued for no signal was always sent "record anyway" (the rep cannot be asked again in the background);
  // one queued after a slow answer / 502 / update (item 0.8) keeps the rep's own choice, and a duplicate warning then shows in the sheet
  // with "Record anyway" (markRefused). Older entries have no flag: as before.
  if (entry.type === "payment") return api.createPaymentForm(paymentForm({ ...entry, confirmDuplicate: entry.confirmDuplicate !== false }), SEND_OPTS);
  return entry.type === "order" ? submitOrder(entry) : submitCheckin(entry);
}

let flushing = false; // a pass is running (retrySoon does not start another)

// How many entry-specific failures (403/409, see below) an entry can rack up
// before automatic flushes stop retrying it on their own -- a broken record
// (e.g. a customer reassigned out from under a queued order) would otherwise
// get silently re-attempted forever on every 'online' event and app boot,
// with the rep never told anything is actually wrong. Past this, the entry
// is flagged needsAttention and only retried again on an explicit, manual
// "Refresh data" tap (flushQueue({ force: true })) -- see settings.js.
const NEEDS_ATTENTION_THRESHOLD = 3;

// Removes one queued entry for good (the "Discard" button of the waiting-to-send sheet, offered
// for entries that stopped retrying on their own).
export async function discardEntry(id) {
  await ready;
  if (!memoryQueue.some((e) => e.id === id && isMine(e))) return; // never another person's work
  memoryQueue = memoryQueue.filter((e) => e.id !== id);
  await removeEntry(id);
  notify();
}

export function getLastSyncedAt() {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  return raw ? Number(raw) : null;
}

// The server looked at an entry and refused it (a 4xx other than the device-wide 401/423/426/429). It is NEVER deleted by the phone (Phase 0
// item 0.1, owner 2026-11-28: a visit refused as "too far", a customer not found or a bad photo used to vanish without a word): it is marked
// "needs attention" with the server's reason, stays in the waiting-to-send sheet, and the rep retries it or discards it there. 403/409 can be
// a passing race (a role change mid-flight, a duplicate check), so they get NEEDS_ATTENTION_THRESHOLD tries first; any other refusal is shown
// at once (sending it again unchanged gives the same answer).
async function markRefused(entry, err) {
  const idx = memoryQueue.findIndex((e) => e.id === entry.id);
  if (idx === -1) return;
  const attempts = (memoryQueue[idx].attempts || 0) + 1;
  const duplicateWarning = err.status === 409 && err.body?.error === "duplicate_warning";
  const retryable = (err.status === 403 || err.status === 409) && !duplicateWarning;
  const updated = {
    ...memoryQueue[idx],
    attempts,
    needsAttention: retryable ? attempts >= NEEDS_ATTENTION_THRESHOLD : true,
    // the server's reason as the rep reads it (core.js already words the known refusals in their language); "not found" in their words too
    lastError: err.status === 404 ? t("sync_refused_not_found") : duplicateWarning ? t("sync_duplicate_payment") : err.message || `HTTP ${err.status}`,
    lastStatus: err.status,
    lastCode: duplicateWarning ? "duplicate_warning" : err.body?.code ?? null,
  };
  memoryQueue = [...memoryQueue.slice(0, idx), updated, ...memoryQueue.slice(idx + 1)];
  await persistEntry(updated);
  notify();
}

// A send that did not get through for a passing reason (no answer in time, the server busy) waits before the automatic passes try it again,
// longer each time (30 s, 1, 2, 4 ... at most 15 minutes), so the 30-second background timer (retrySoon) does not upload a large check-in
// again and again on weak signal. Only that timer waits: signal back ('online'), a sign-in, the app start and "Retry now" send at once. It is
// never marked "needs attention" or deleted for that.
const BACKOFF_MS = (fails) => Math.min(15 * 60 * 1000, 30000 * 2 ** Math.max(0, fails - 1));
async function markDeferred(entry) {
  const idx = memoryQueue.findIndex((e) => e.id === entry.id);
  if (idx === -1) return;
  const fails = (memoryQueue[idx].transientFails || 0) + 1;
  const updated = { ...memoryQueue[idx], transientFails: fails, retryAt: Date.now() + BACKOFF_MS(fails) };
  memoryQueue = [...memoryQueue.slice(0, idx), updated, ...memoryQueue.slice(idx + 1)];
  await persistEntry(updated);
}

// "Record anyway" for a queued payment the server warned is a duplicate (the waiting-to-send sheet): the rep decided, it is sent at once.
export async function confirmDuplicateEntry(id) {
  await ready;
  const idx = memoryQueue.findIndex((e) => e.id === id && isMine(e));
  if (idx === -1) return;
  const updated = { ...memoryQueue[idx], confirmDuplicate: true, needsAttention: false, lastError: null, lastCode: null, attempts: 0 };
  memoryQueue = [...memoryQueue.slice(0, idx), updated, ...memoryQueue.slice(idx + 1)];
  await persistEntry(updated);
  notify();
  await flushQueue({ force: true });
}

// One pass at a time. A "Retry now" (force) that arrives while an automatic pass is running is not lost: a forced pass follows it.
let currentPass = null;
let forcedNext = null;
export function flushQueue({ force = false, timer = false } = {}) {
  if (currentPass) {
    if (!force) return currentPass;
    forcedNext ??= currentPass.then(() => {
      forcedNext = null;
      return flushQueue({ force: true });
    });
    return forcedNext;
  }
  currentPass = runPass(force, timer).finally(() => {
    currentPass = null;
  });
  return currentPass;
}

async function runPass(force, timer) {
  flushing = true;
  try {
    await ready;
    notify(); // the person signed in may have changed: the banner and sheet show this person's entries only
    if (currentUserId() == null) return;
    // An entry saved by an app from before the owner rule (no userId) becomes the signed-in person's now, once, so a later sign-in by
    // someone else on this phone cannot send it under their login.
    for (const entry of memoryQueue.filter((e) => e.userId == null)) {
      const owned = { ...entry, userId: currentUserId() };
      memoryQueue = memoryQueue.map((e) => (e.id === entry.id ? owned : e));
      await persistEntry(owned);
    }
    for (const entry of [...memoryQueue]) {
      // Another person's work waits for them (see isMine).
      if (!isMine(entry)) continue;
      // A flagged entry is skipped by the automatic passes (online event,
      // app boot) -- it already proved it won't succeed by itself. A manual
      // retry (force: true) always gets another attempt, since the rep
      // presumably did something about the underlying cause first.
      if (entry.needsAttention && !force) continue;
      // waiting after a slow answer / busy server (markDeferred)
      if (timer && entry.retryAt && entry.retryAt > Date.now()) continue;
      try {
        await submitEntry(entry);
        memoryQueue = memoryQueue.filter((e) => e.id !== entry.id);
        await removeEntry(entry.id);
        notify();
        // a payment saved without signal is in the list now (the badge and an open Payments screen refresh)
        if (entry.type === "payment") window.dispatchEvent(new Event("payments-changed"));
      } catch (err) {
        // 401 (session expired), 429/423 (rate-limited / app-wide emergency
        // lockdown) and 426 (this app version must update first) affect
        // every request this device makes right now, not just this entry --
        // stop the whole pass; the 'online' listener, the next login or the
        // updated app retries later.
        if ([401, 423, 426, 429].includes(err.status)) break;
        // The server looked at this entry and refused it: keep it, flagged with the reason (markRefused).
        if (err.status >= 400 && err.status < 500 && err.status !== 408) {
          await markRefused(entry, err);
          continue;
        }
        // No answer in time (408 from the send limit) is about THIS upload (often a large one): it waits (markDeferred) and the entries
        // behind it still get their turn. The server or its proxy down (5xx): the entry waits too, and the pass stops (every other send
        // would meet the same wall). No network (TypeError) or no status: the pass stops; the 'online' event brings it back.
        if (err.status === 408) {
          await markDeferred(entry);
          continue;
        }
        if (err.status >= 500) await markDeferred(entry);
        break;
      }
    }
    if (!memoryQueue.some(isMine)) localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } finally {
    flushing = false;
  }
}

window.addEventListener("online", () => flushQueue());

// A save can be queued while the phone HAS signal (no answer in 30 s, a 502/503/504 during a deploy; item 0.8), and iPhone Safari does not
// always report "signal is back": no 'online' event would ever come. While this person has entries that can be sent, try again every
// QUEUE_RETRY_MS and whenever the app comes to the front.
const QUEUE_RETRY_MS = 30000;
const retrySoon = () => {
  if (document.hidden || !navigator.onLine || flushing) return;
  if (memoryQueue.some((e) => isMine(e) && !e.needsAttention && !(e.retryAt > Date.now()))) flushQueue({ timer: true });
};
setInterval(retrySoon, QUEUE_RETRY_MS);
document.addEventListener("visibilitychange", retrySoon);
