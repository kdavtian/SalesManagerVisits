// "You are at the office" (owner, 2026-11-03): the foreground location ping (locationBroadcast.js) is answered by the server with the office the
// phone is standing at, if any (field/offices.js). Show a small banner with a one-tap "Check in"; a day may also start from the first field
// visit, so this is only a suggestion (closing it asks again after the server's quiet period, never nags within the same visit).
import { t } from "./i18n.js";
import { escapeHtml } from "./util.js";

let navigateFn = null;
let shownFor = null;
let dismissedFor = null;

export function setOfficeNavigator(fn) {
  navigateFn = fn;
}

function banner() {
  let el = document.getElementById("office-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "office-banner";
    el.className = "arrival-banner";
    el.setAttribute("role", "status");
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

function hide() {
  const el = document.getElementById("office-banner");
  if (el) el.hidden = true;
  shownFor = null;
}

// office: { id, name } from the ping's answer, or null when the phone is not at an office
export function handleOfficeNear(office) {
  if (!office) {
    dismissedFor = null; // left the place: a later return may suggest again
    if (shownFor != null) hide();
    return;
  }
  if (office.id === shownFor || office.id === dismissedFor) return;
  const el = banner();
  el.innerHTML = `
    <div class="arrival-head">
      <strong>${escapeHtml(t("office_here_title").replace("{name}", office.name))}</strong>
      <button type="button" class="icon-btn arrival-close" aria-label="${t("close")}">&times;</button>
    </div>
    <p class="arrival-sub">${t("office_here_sub")}</p>
    <div class="arrival-actions">
      <button type="button" class="btn btn-primary" data-act="checkin">${t("check_in")}</button>
      <button type="button" class="btn" data-act="later">${t("office_here_later")}</button>
    </div>`;
  el.hidden = false;
  shownFor = office.id;
  el.querySelector(".arrival-close").addEventListener("click", () => {
    dismissedFor = office.id;
    hide();
  });
  el.querySelector('[data-act="later"]').addEventListener("click", () => {
    dismissedFor = office.id;
    hide();
  });
  el.querySelector('[data-act="checkin"]').addEventListener("click", () => {
    hide();
    navigateFn?.(`#/checkin/${office.id}`);
  });
}
