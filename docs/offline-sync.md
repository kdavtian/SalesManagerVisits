# Offline sync

Field reps lose connectivity regularly (inside a garage/workshop, weak
rural signal). Check-ins and orders can be created while offline; they
queue on-device and replay automatically once connectivity returns. This
doc covers how that queue actually behaves — idempotency, retries,
conflicts, and what the rep sees at each step.

Implementation: `client/public/js/offlineQueue.js`.

## Storage

IndexedDB-backed (`fieldvisits_offline` database), not `localStorage` —
async (doesn't block the main thread on write), higher quota, and can
store photo `Blob`s natively instead of base64-inflating them into a
5-10MB `localStorage` budget. An in-memory copy (`memoryQueue`) is the
single source of truth for synchronous reads (`getQueue()`,
`onQueueChange()`), kept in lockstep with IndexedDB on every mutation.
Falls back to `localStorage` if IndexedDB is unavailable (private
browsing, storage pressure) — same external behavior, smaller effective
capacity.

## What can be queued

- Check-ins (`submitCheckin`)
- Orders (`submitOrder`)

Both go through the same `flushQueue()` replay loop; entries queued
before an app version that added order support default to "checkin" for
backward compatibility with anything already sitting in a rep's queue
across a deploy.

## Idempotency

Every queued entry carries a `client_ref` — the entry's own locally-
generated ID, sent as a form field on submit
(`form.set("client_ref", entry.clientRef || entry.id)`). The server keys
off this to make a retried submission a no-op instead of a duplicate: if
`flushQueue()` retries an entry that actually succeeded server-side on a
prior attempt (e.g. the response was lost to a network drop after the
server had already committed), the server recognizes the same
`client_ref` and returns the existing record rather than creating a
second one.

## When sync happens

- Automatically on the browser's `online` event.
- Automatically on app boot (if there's a pending queue and connectivity).
- Manually via Settings → "Refresh data" (`flushQueue({ force: true })`).

## Retry and conflict behavior

`flushQueue()` walks the queue in order and classifies each failure by
HTTP status:

| Status | Meaning | Behavior |
|---|---|---|
| `401` | Session expired | **Stops the whole pass.** Not entry-specific — every request from this device will fail the same way until re-authenticated. Retried on the next `online` event or login. |
| `429` / `423` | Rate-limited / app-wide emergency lockdown (see [incident-response.md](incident-response.md)) | **Stops the whole pass**, same reasoning as 401 — a device-wide condition, not this entry's fault. |
| `403` / `409` | Entry-specific conflict (a role change mid-flight, an idempotency-check race, a stale reference — e.g. the customer this check-in targets was deleted) | **Does not block the rest of the queue.** The entry's `attempts` counter increments; after 3 failures (`NEEDS_ATTENTION_THRESHOLD`) it's flagged `needsAttention` and skipped by future *automatic* passes — it keeps showing in the sync banner, but won't silently retry forever against the same wall. A manual "Refresh data" tap always gives it one more try. |
| Other 4xx | The server looked at this entry and rejected it outright (e.g. the referenced customer no longer exists) | **Dropped from the queue.** Retrying a genuine rejection forever would never succeed. |
| Network failure / 5xx / no status | Transient — server hiccup, connection genuinely down mid-request | **Stops the whole pass**, retried later. Never discards a rep's real work because the server had a bad moment. |

On any successful submission, the entry is removed from the queue and
`fieldvisits_last_synced_at` is updated once the whole queue empties (not
per-entry) — that's what Settings' "Last synced" timestamp reflects.

## What the rep sees

- A sync banner (`app.js`'s `renderSyncBanner`) shows pending-entry count
  while offline, or a "needs attention" call-to-action once any entry
  crosses the retry threshold — tapping it navigates to Settings.
- Settings' Data & Sync section shows the queue, last-synced time, and the
  manual "Refresh data" action.
- A queued order shows a distinct "queued while offline" result screen
  immediately on submit, rather than looking like it silently vanished.

## Conflict resolution philosophy

There is **no merge/three-way-conflict UI** — the queue is a simple
retry-with-backoff-to-manual model, not a CRDT or operational-transform
system. A genuine conflict (the customer/order this entry depends on
changed shape while offline) surfaces as a 403/409 that needs a human to
look at (`needsAttention`), not an automatic resolution. This is a
deliberate scope choice for the actual conflict rate this app sees (rare
— one rep editing their own queued work, not concurrent edits to the same
record from multiple offline devices) rather than a limitation to fix.

## Testing this

`server/test/e2e/offline-order.spec.mjs` drives the full loop end-to-end
with Playwright (`context.setOffline(true)`, submit, verify the queued
state, go back online, verify it synced) — see
[`local-development.md`](local-development.md#running-checks) for how to
run it.
