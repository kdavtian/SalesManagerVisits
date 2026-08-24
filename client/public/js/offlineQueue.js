import { api } from "./api.js";

const QUEUE_KEY = "fieldvisits_pending_checkins";
const listeners = new Set();

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  listeners.forEach((fn) => fn(queue));
}

export function getQueue() {
  return readQueue();
}

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function enqueueCheckin(entry) {
  const queue = readQueue();
  queue.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...entry });
  writeQueue(queue);
}

async function submitEntry(entry) {
  const form = new FormData();
  form.set("customer_id", entry.customerId);
  form.set("lat", entry.lat);
  form.set("lng", entry.lng);
  if (entry.note) form.set("note", entry.note);
  if (entry.brands?.length) form.set("brands_found", JSON.stringify(entry.brands));
  if (entry.outcome) form.set("outcome", entry.outcome);
  if (entry.photoDataUrl) {
    const blob = await (await fetch(entry.photoDataUrl)).blob();
    form.set("photo", blob, "checkin.jpg");
  }
  return api.createCheckin(form);
}

let flushing = false;

const LAST_SYNC_KEY = "fieldvisits_last_synced_at";

export function getLastSyncedAt() {
  const raw = localStorage.getItem(LAST_SYNC_KEY);
  return raw ? Number(raw) : null;
}

export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let queue = readQueue();
    for (const entry of [...queue]) {
      try {
        await submitEntry(entry);
        queue = queue.filter((e) => e.id !== entry.id);
        writeQueue(queue);
      } catch (err) {
        if (err instanceof TypeError) {
          // Network-level failure (offline) — stop and retry later.
          break;
        }
        // Server rejected the entry (e.g. customer deleted) — drop it, don't retry forever.
        queue = queue.filter((e) => e.id !== entry.id);
        writeQueue(queue);
      }
    }
    if (!queue.length) localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } finally {
    flushing = false;
  }
}

window.addEventListener("online", flushQueue);
