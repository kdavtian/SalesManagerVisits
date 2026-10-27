// Electronic signature (owner, 2026-10-26): a full-screen pad to draw a signature with a finger. Used by the rep and the driver (their own
// signature, drawn once and kept on the profile) and by the customer (on the rep's phone, at the delivery).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { state } from "./state.js";
import { activateDialog, showToast, escapeHtml as escapeText } from "./util.js";

const INK = "#10224a";
const PENDING_KEY = "fv_pending_own_signature";

// Resolves with a PNG Blob (transparent background, cropped to the strokes), or null when cancelled.
// statement: what the customer confirms by signing (owner, 2026-10-27: "he should know what he is signing for"), shown large above the pad.
export function openSignaturePad({ title, hint = "", doneLabel = "", statement = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sig-pad";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="sig-pad-card">
        <div class="sig-pad-head">
          <h2>${title}</h2>
          <button type="button" class="icon-btn sheet-close-x" data-act="cancel" aria-label="${t("close")}">${icons.close}</button>
        </div>
        ${statement ? `<p class="sig-pad-statement">${escapeText(statement)}</p>` : ""}
        ${hint ? `<p class="muted sig-pad-hint">${hint}</p>` : ""}
        <div class="sig-pad-board"><canvas class="sig-pad-canvas"></canvas><span class="sig-pad-line" aria-hidden="true"></span></div>
        <p class="form-error" id="sig-pad-error" hidden>${t("signature_too_short")}</p>
        <div class="sig-pad-actions">
          <button type="button" class="btn" data-act="clear">${t("clear")}</button>
          <button type="button" class="btn btn-primary" data-act="done">${doneLabel || t("done")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    activateDialog(overlay);

    const canvas = overlay.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
    };
    size();

    let strokes = [];
    let current = null;
    const point = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const paint = () => {
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
      for (const stroke of strokes) {
        ctx.beginPath();
        stroke.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else {
            // a quadratic curve through the midpoints keeps a finger's jagged samples smooth
            const prev = stroke[i - 1];
            ctx.quadraticCurveTo(prev.x, prev.y, (prev.x + p.x) / 2, (prev.y + p.y) / 2);
          }
        });
        if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1);
        ctx.stroke();
      }
    };
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      current = [point(e)];
      strokes.push(current);
      overlay.querySelector("#sig-pad-error").hidden = true;
      paint();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!current) return;
      e.preventDefault();
      current.push(point(e));
      paint();
    });
    const end = () => (current = null);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    const finish = (blob) => {
      document.body.style.overflow = "";
      overlay.remove();
      resolve(blob);
    };

    // Crops the drawing to its strokes (plus a margin), so every signature fills its box on the paper whatever the pad size was.
    const exportPng = () =>
      new Promise((resolve2) => {
        const pts = strokes.flat();
        const margin = 6;
        const minX = Math.min(...pts.map((p) => p.x)) - margin;
        const maxX = Math.max(...pts.map((p) => p.x)) + margin;
        const minY = Math.min(...pts.map((p) => p.y)) - margin;
        const maxY = Math.max(...pts.map((p) => p.y)) + margin;
        const w = Math.max(1, Math.round((maxX - minX) * dpr));
        const h = Math.max(1, Math.round((maxY - minY) * dpr));
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        out.getContext("2d").drawImage(canvas, Math.round(minX * dpr), Math.round(minY * dpr), w, h, 0, 0, w, h);
        out.toBlob(resolve2, "image/png");
      });

    overlay.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "cancel") return finish(null);
      if (act === "clear") {
        strokes = [];
        paint();
        return;
      }
      if (act === "done") {
        const pts = strokes.flat();
        const spread = pts.length ? Math.max(Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))) : 0;
        if (pts.length < 8 || spread < 24) {
          overlay.querySelector("#sig-pad-error").hidden = false;
          return;
        }
        finish(await exportPng());
      }
    });
  });
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

async function pendingOwnSignature() {
  try {
    const dataUrl = localStorage.getItem(PENDING_KEY);
    return dataUrl ? await (await fetch(dataUrl)).blob() : null;
  } catch {
    return null;
  }
}

export const clearPendingOwnSignature = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing kept */
  }
};

// The rep's / driver's own signature (owner: "silent", no extra click at the delivery). Drawn ONCE, the first time it is needed, and kept on the
// profile. Resolves with { ok, pending }: ok = false when they cancelled; pending = a Blob that could not be uploaded yet (the phone is offline)
// and must travel with the check-in instead (the server saves it from there).
export async function ensureOwnSignature() {
  if (state.user.has_signature) return { ok: true, pending: null };
  const kept = await pendingOwnSignature();
  if (kept) return { ok: true, pending: kept };
  const blob = await openSignaturePad({ title: t("signature_own_title"), hint: t("signature_own_hint") });
  if (!blob) return { ok: false, pending: null };
  try {
    await api.saveMySignature(blob);
    state.user.has_signature = true;
    return { ok: true, pending: null };
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    // offline: keep it on the phone until a check-in can carry it
    try {
      localStorage.setItem(PENDING_KEY, await blobToDataUrl(blob));
    } catch {
      /* the check-in still carries the blob in memory */
    }
    return { ok: true, pending: blob };
  }
}

// Settings > "My signature": draw it again (replaces the one on the profile).
export async function redrawOwnSignature() {
  const blob = await openSignaturePad({ title: t("signature_own_title"), hint: t("signature_own_hint") });
  if (!blob) return false;
  await api.saveMySignature(blob);
  state.user.has_signature = true;
  clearPendingOwnSignature();
  showToast(t("signature_saved"));
  return true;
}
