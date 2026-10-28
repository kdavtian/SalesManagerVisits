// Settings: the guide, the admin section overlay, change password and the sales performance card (moved out of settings.js with the
// refactor tool, docs/architecture-roadmap.md step 6).
import { api } from "../../api.js";
import { getLang, t } from "../../i18n.js";
import { ownsCustomers } from "../../shared/roles.js";
import { activateDialog, attachSwipeToDismiss, escapeHtml } from "../../util.js";
import { ICON } from "./rows.js";

// Shown in-app full-screen with its own X to get back to Settings. The
// iframe preview is only best-effort: an installed iOS PWA's WKWebView
// can't render a PDF inside an iframe at all (it just renders blank),
// which is why the guide looked "not working" for reps using the
// home-screen app. Share/Open are the actual guaranteed-working path on
// every platform -- Share hands the real PDF file to the OS share sheet
// (save to Files, send in a chat, print, etc.), Open falls back to letting
// the browser/OS handle the PDF URL directly.
export function openGuideOverlay() {
  const pdfUrl = `/docs/kad-motors-guide-${getLang() === "en" ? "en" : "hy"}.pdf`;
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay guide-overlay";
  overlay.innerHTML = `
    <div class="guide-overlay-frame">
      <div class="guide-overlay-toolbar">
        <button type="button" class="icon-btn guide-overlay-close" id="guide-overlay-close" aria-label="${t("close")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="guide-overlay-toolbar-actions">
          <button type="button" class="btn btn-sm" id="guide-share-btn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:4px;"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>${t("share_pdf")}
          </button>
          <a class="btn btn-sm" id="guide-open-btn" href="${pdfUrl}" target="_blank" rel="noopener">${t("open_pdf")}</a>
        </div>
      </div>
      <iframe src="${pdfUrl}" title="${t("user_guide")}"></iframe>
      <p class="muted guide-overlay-fallback-hint">${t("guide_preview_fallback_hint")}</p>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#guide-overlay-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  attachSwipeToDismiss(overlay, overlay.querySelector(".guide-overlay-frame"), close);

  const shareBtn = overlay.querySelector("#guide-share-btn");
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    try {
      const res = await fetch(pdfUrl);
      const blob = await res.blob();
      const file = new File([blob], "KAD-Motors-Guide.pdf", { type: "application/pdf" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: t("user_guide") });
      } else if (navigator.share) {
        // Some browsers support share() but not file sharing -- share the
        // absolute URL instead of nothing.
        await navigator.share({ url: new URL(pdfUrl, location.href).href, title: t("user_guide") });
      } else {
        window.open(pdfUrl, "_blank");
      }
    } catch (err) {
      if (err?.name !== "AbortError") window.open(pdfUrl, "_blank");
    } finally {
      shareBtn.disabled = false;
    }
  });
}

// Computer width (the app's single 1024px breakpoint): a row's screen (Team management, ...) opens inside the main
// column in place of the page, with a Back button named after the page -- the macOS System Settings drill-down.
// Phones open the same screen as a full-screen overlay (openAdminSectionOverlay). matchMedia is read on every click
// on purpose; a resize closes any open pane (see onWideChange in renderSettings).
export function openAdminSection(root, rowEl, title, renderFn) {
  if (!window.matchMedia("(min-width: 1024px)").matches) {
    openAdminSectionOverlay(title, renderFn);
    return;
  }
  const view = root.querySelector(".settings-view");
  const pane = root.querySelector("#settings-section-pane");
  const pageTitle = rowEl.closest(".settings-page")?.dataset.title || t("settings_title");
  pane.hidden = false;
  view.dataset.drill = "1";
  pane.innerHTML = `<button type="button" class="settings-back settings-pane-back">${ICON.back}<span>${escapeHtml(pageTitle)}</span></button><h2>${escapeHtml(title)}</h2><div id="settings-section-pane-content"></div>`;
  pane.querySelector(".settings-pane-back").addEventListener("click", () => {
    view.removeAttribute("data-drill");
    pane.hidden = true;
    pane.innerHTML = "";
  });
  pane.scrollIntoView({ block: "start" });
  renderFn(pane.querySelector("#settings-section-pane-content"));
}

// Product catalog and team management used to render as full inline
// sections directly on the Settings page -- with plan approvals, financial
// exports, notification defaults etc. also stacked there, the page got very
// long for an admin/director. Each now collapses to a single row that opens
// its content in a full-screen overlay instead, same shell as the guide
// viewer (mobile width -- see openAdminSection above for the desktop path).
export function openAdminSectionOverlay(title, renderFn) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay guide-overlay";
  overlay.innerHTML = `
    <div class="guide-overlay-frame">
      <div class="admin-section-overlay-toolbar">
        <button type="button" class="icon-btn guide-overlay-close" id="admin-section-close" aria-label="${t("close")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="admin-section-overlay-body" id="admin-section-overlay-body">
        <h2>${escapeHtml(title)}</h2>
        <div id="admin-section-overlay-content"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  const frame = overlay.querySelector(".guide-overlay-frame");
  const body = overlay.querySelector("#admin-section-overlay-body");
  function close() {
    overlay.remove();
  }
  overlay.querySelector("#admin-section-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  attachSwipeToDismiss(overlay, frame, close);
  // Tapping the toolbar (the strip right below the real status bar) scrolls
  // this overlay's own content to top -- emulates iOS's native
  // tap-status-bar-to-scroll-top, which can't otherwise reach this overlay
  // (it's a plain DOM sheet, not the document itself).
  overlay.querySelector(".admin-section-overlay-toolbar").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    body.scrollTo({ top: 0, behavior: "smooth" });
  });

  renderFn(overlay.querySelector("#admin-section-overlay-content"));
}

export function openChangePasswordSheet() {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("change_password")}</h2>
      <form id="change-password-form">
        <label>${t("current_password")}<input name="current_password" type="password" required /></label>
        <label>${t("new_password")}<input name="new_password" type="password" minlength="8" required /></label>
        <p class="form-error" id="change-password-error" hidden></p>
        <p class="form-success" id="change-password-success" role="status" hidden>${t("password_updated")}</p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="cancel-change-password">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);

  function close() {
    overlay.remove();
  }
  overlay.querySelector("#cancel-change-password").addEventListener("click", close);
  overlay.addEventListener("click", (e) => e.target === overlay && close());

  const form = overlay.querySelector("#change-password-form");
  const errorEl = overlay.querySelector("#change-password-error");
  const successEl = overlay.querySelector("#change-password-success");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await api.changeMyPassword(data.get("current_password"), data.get("new_password"));
      successEl.hidden = false;
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

export function formatAmdShort(value) {
  return `${Math.round(value).toLocaleString("en-US")} ${t("amd")}`;
}

export function targetProgressHtml(salesAmd, budgetAmd) {
  const budget = Number(budgetAmd);
  if (!budget) return `<p class="muted perf-no-target">${t("no_target_set")}</p>`;
  const sales = Number(salesAmd) || 0;
  const pct = Math.max(0, sales / budget);
  const clamped = Math.min(1, pct);
  return `
    <div class="progress-bar" role="progressbar" aria-valuenow="${Math.round(pct * 100)}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar-fill" style="width:${clamped * 100}%"></div>
    </div>
    <p class="muted perf-progress-label">${Math.round(pct * 100)}% ${t("of_target")}</p>
  `;
}

export async function loadSalesPerformance(slot, role) {
  slot.innerHTML = `<h2 class="section-title">${t("sales_performance_title")}</h2><p class="loading-state" role="status">${t("loading")}</p>`;

  const wantsOwn = ownsCustomers(role);

  let mine = null;
  try {
    mine = wantsOwn ? await api.getMySalesPerformance() : null;
  } catch {
    slot.innerHTML = "";
    return;
  }

  const sections = [];

  if (wantsOwn) {
    sections.push(`<h2 class="section-title">${t("sales_performance_title")}</h2>`);
    if (!mine?.synced) {
      sections.push(`<div class="card"><p class="muted">${t("no_sales_data_yet")}</p></div>`);
    } else {
      const cm = mine.current_month;
      sections.push(`
        <div class="card">
          <div class="perf-row"><span class="muted">${t("this_month_sales")}</span><strong>${formatAmdShort(cm?.sales_amd ?? 0)}</strong></div>
          <div class="perf-row"><span class="muted">${t("this_month_collected")}</span><strong>${formatAmdShort(cm?.collected_amd ?? 0)}</strong></div>
          <div class="perf-row"><span class="muted">${t("this_month_target")}</span><strong>${formatAmdShort(cm?.budget_amd ?? 0)}</strong></div>
          ${targetProgressHtml(cm?.sales_amd, cm?.budget_amd)}
          <div class="perf-divider"></div>
          <div class="perf-row"><span class="muted">${t("ytd_sales")}</span><strong>${formatAmdShort(mine.ytd.sales_amd)}</strong></div>
          <div class="perf-row"><span class="muted">${t("ytd_collected")}</span><strong>${formatAmdShort(mine.ytd.collected_amd)}</strong></div>
          <div class="perf-row"><span class="muted">${t("ytd_target")}</span><strong>${formatAmdShort(mine.ytd.budget_amd)}</strong></div>
          ${targetProgressHtml(mine.ytd.sales_amd, mine.ytd.budget_amd)}
        </div>
      `);
    }
  }

  // The cross-rep leaderboard used to live here, but it's now fully
  // superseded by the dedicated Team Performance module (reachable from the
  // dashboard's Quick Actions) -- keeping both would just be two different
  // numbers for the same thing in two different places.

  slot.innerHTML = sections.join("");
}
