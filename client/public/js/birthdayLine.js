// "Birthday today" on Home for everybody (owner, 2026-11-03): the names of the colleagues whose birthday it is, with a one-tap "Congratulate".
// Names only: no age, no date of birth. Fetched after Home is drawn, never blocks it (GET /api/birthdays/today).
import { api } from "./api.js";
import { t, getLang } from "./i18n.js";
import { escapeHtml } from "./util.js";

const nameOf = (p) => (getLang() === "hy" && p.name_hy ? p.name_hy : p.name);

function paint(slot, people) {
  slot.innerHTML = `<section class="card birthday-card" aria-label="${escapeHtml(t("bday_today"))}">
    <h2 class="section-title section-title-inline">&#127874; ${t("bday_today")}</h2>
    ${people
      .map((p) =>
        p.is_me
          ? `<p class="birthday-me">${escapeHtml(t("bday_you").replace("{name}", nameOf(p).split(/\s+/)[0]))}</p>`
          : `<div class="birthday-row"><strong>${escapeHtml(nameOf(p))}</strong>${
              p.wished
                ? `<span class="muted birthday-done">&#10003; ${t("bday_congratulated")}</span>`
                : `<button type="button" class="btn btn-primary btn-sm" data-wish="${p.staff_id}">${t("bday_congratulate")}</button>`
            }</div>`
      )
      .join("")}
  </section>`;
  slot.querySelectorAll("[data-wish]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api.wishBirthday(Number(b.dataset.wish));
        const person = people.find((p) => p.staff_id === Number(b.dataset.wish));
        if (person) person.wished = true;
        paint(slot, people);
      } catch {
        b.disabled = false;
      }
    })
  );
}

export async function renderBirthdayLine(slot) {
  try {
    const { people } = await api.getBirthdaysToday();
    if (people.length && slot.isConnected) paint(slot, people);
  } catch {
    // nothing to celebrate, or no signal: Home stays as it is
  }
}
