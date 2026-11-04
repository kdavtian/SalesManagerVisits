// Pinned screens (owner, 2026-11-04): each person pins up to 4 screens; they show at the top of Home and of the desktop sidebar. Saved on the
// server (GET/PUT /api/me/pins, checked against what the role may open), so they follow the person to every device. A tap on a pin toggle
// shows the change at once; when saving fails it is put back and said.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { state } from "./state.js";
import { escapeHtml, showToast } from "./util.js";
import { MAX_PINS, cleanPins } from "./shared/screens.js";
import { pinnableIds, screenItems } from "./screenCatalog.js";
import { icons } from "./icons.js";

let pins = null; // null until the server answered once (the saved user's copy is used meanwhile)
let loading = null;

export function currentPins(settings) {
  const raw = pins ?? state.user?.pinned_screens ?? [];
  return settings ? cleanPins(raw, pinnableIds(settings)) : cleanPins(raw, raw);
}

export function isPinned(id) {
  return currentPins().includes(id);
}

function changed() {
  if (state.user) state.user.pinned_screens = pins;
  window.dispatchEvent(new Event("pins-changed"));
}

export function loadPins() {
  if (!state.user) return Promise.resolve([]);
  loading ??= api
    .getPins()
    .then((r) => {
      pins = r.pins ?? [];
      changed();
      return pins;
    })
    .catch(() => currentPins())
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Pins or unpins `id`; resolves to true when it is pinned afterwards. */
export async function togglePin(id) {
  const before = currentPins();
  const pinnedNow = before.includes(id);
  if (!pinnedNow && before.length >= MAX_PINS) {
    showToast(t("pins_full").replace("{n}", String(MAX_PINS)));
    return false;
  }
  pins = pinnedNow ? before.filter((x) => x !== id) : [...before, id];
  changed();
  try {
    const r = await api.savePins(pins);
    pins = r.pins;
    changed();
  } catch (err) {
    pins = before;
    changed();
    showToast(err?.message || t("pins_save_failed"));
  }
  return pins.includes(id);
}

/** The pinned screens as catalog items (icon, label, hash), in the person's order. */
export function pinnedItems(settings) {
  const byId = new Map(screenItems(settings).map((s) => [s.id, s]));
  return currentPins(settings).map((id) => byId.get(id)).filter(Boolean);
}

/** The pin toggle of a row (More sheet, search): a 44 px button, pressed when pinned. */
export function pinButtonHtml(id) {
  const on = isPinned(id);
  return `<button type="button" class="pin-toggle${on ? " is-pinned" : ""}" data-pin="${escapeHtml(id)}" aria-pressed="${on}" aria-label="${escapeHtml(t(on ? "pin_remove" : "pin_add"))}" title="${escapeHtml(t(on ? "pin_remove" : "pin_add"))}">${on ? icons.pushpinFilled : icons.pushpin}</button>`;
}

/** Wires every pin toggle inside `root` (one listener), repainting the toggles after a change. */
export function bindPinButtons(root) {
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-pin]");
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    await togglePin(btn.dataset.pin);
  });
  const repaint = () => {
    if (!root.isConnected) {
      window.removeEventListener("pins-changed", repaint);
      return;
    }
    root.querySelectorAll("[data-pin]").forEach((btn) => {
      const on = isPinned(btn.dataset.pin);
      btn.classList.toggle("is-pinned", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", t(on ? "pin_remove" : "pin_add"));
      btn.title = t(on ? "pin_remove" : "pin_add");
      btn.innerHTML = on ? icons.pushpinFilled : icons.pushpin;
    });
  };
  window.addEventListener("pins-changed", repaint);
}

/** The "Pinned" row at the top of Home: nothing when nothing is pinned. Redraws itself when the pins change while it is on screen. */
export function mountPinnedRow(slot, navigate, settings) {
  const paint = () => {
    if (!slot.isConnected) {
      window.removeEventListener("pins-changed", paint);
      return;
    }
    const items = pinnedItems(settings);
    slot.hidden = !items.length;
    slot.innerHTML = items.length
      ? `<section class="pinned-row" aria-label="${escapeHtml(t("pins_title"))}">
          <h2 class="section-title section-title-tight">${escapeHtml(t("pins_title"))}</h2>
          <div class="pinned-row-items">${items
            .map(
              (it) => `<button type="button" class="pinned-chip" data-hash="${escapeHtml(it.hash)}">
                <span class="pinned-chip-icon quick-action-icon ${it.colorClass || "quick-action-icon-accent"}">${it.icon}</span>
                <span class="pinned-chip-label">${escapeHtml(it.label)}</span>
              </button>`
            )
            .join("")}</div>
        </section>`
      : "";
  };
  slot.addEventListener("click", (e) => {
    const chip = e.target.closest?.("[data-hash]");
    if (chip) navigate(chip.dataset.hash);
  });
  window.addEventListener("pins-changed", paint);
  paint();
}
