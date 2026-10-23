// Staff (owner, 2026-10-23): people, who reports to whom, payroll of a month, the day-by-day calendar of a person, premiums / bonuses / deductions
// and the company rules. Replaces the Excel sheets Tabel, Sales Team and Plan. Pay maths is on the server (server/src/payroll.js); this screen shows
// it and lets the right people change it: admin / CEO / accountant manage, a boss marks the days of the people below, everybody sees their own.
import { api } from "../api.js";
import { t, getLang } from "../i18n.js";
import { activateDialog, escapeHtml, showToast, bindAmdInput, parseAmd } from "../util.js";

const TABS = ["pay", "people", "tree", "rules"];
const KINDS = ["executive", "director", "rep", "office", "warehouse", "driver"];
const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthTitle = (m) => {
  const [y, mo] = m.split("-").map(Number);
  const lang = getLang() === "hy" ? "hy-AM" : "en-GB";
  return new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, 1)));
};
const signed = (n) => `${n < 0 ? "−" : ""}${nf(Math.abs(n))}`;

function monthBar(month) {
  return `<div class="st-monthbar">
    <button type="button" class="btn st-month-btn" data-month="-1" aria-label="${escapeHtml(t("st_month_prev"))}">‹</button>
    <strong>${escapeHtml(monthTitle(month))}</strong>
    <button type="button" class="btn st-month-btn" data-month="1" aria-label="${escapeHtml(t("st_month_next"))}">›</button>
  </div>`;
}

function openSheet(html) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet">${html}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  return overlay;
}

export async function renderStaff(root, navigate, personId = null, query = new URLSearchParams()) {
  const month0 = /^\d{4}-\d{2}$/.test(query.get("month") ?? "") ? query.get("month") : thisMonth();
  root.innerHTML = `<div class="st-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  let access;
  try {
    access = await api.getStaffAccess();
  } catch (err) {
    root.innerHTML = `<div class="st-view"><p class="form-error">${escapeHtml(err.message)}</p></div>`;
    return;
  }
  if (!access.has_access) {
    root.innerHTML = `<div class="st-view"><h1>${t("st_title")}</h1><p class="muted">${t("st_none_self")}</p></div>`;
    return;
  }
  if (personId) return renderPerson(root, navigate, personId, month0, access);
  return renderMain(root, navigate, month0, access, TABS.includes(query.get("tab")) ? query.get("tab") : "pay");
}

// ---- the list screen: Payroll / People / Structure / Rules ---------------------------------------------------------------------
async function renderMain(root, navigate, month0, access, tab0) {
  const st = { tab: tab0, month: month0 };
  const tabs = TABS.filter((x) => (x === "people" || x === "rules" ? access.can_manage || (x === "rules" && access.can_set_rules) : true));
  let people = [];
  let payroll = null;

  root.innerHTML = `
    <div class="st-view">
      <div class="st-head"><h1>${t("st_title")}</h1></div>
      <div class="activity-tabs" role="tablist" id="st-tabs"></div>
      <div id="st-body"></div>
    </div>`;
  const body = root.querySelector("#st-body");

  const paintTabs = () => {
    root.querySelector("#st-tabs").innerHTML = tabs
      .map((x) => `<button role="tab" aria-selected="${x === st.tab}" class="activity-tab ${x === st.tab ? "activity-tab-active" : ""}" data-tab="${x}">${t(`st_tab_${x}`)}</button>`)
      .join("");
  };
  root.querySelector("#st-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b || b.dataset.tab === st.tab) return;
    st.tab = b.dataset.tab;
    paintTabs();
    paint();
  });

  const personLink = (id) => `#/staff/${id}?month=${st.month}`;
  const goPerson = (id) => navigate(personLink(id));

  async function loadPeople() {
    people = (await api.getStaffPeople()).people;
  }

  // -- payroll --
  async function paintPay() {
    body.innerHTML = `${monthBar(st.month)}<p class="loading-state" role="status">${t("loading")}</p>`;
    wireMonth();
    try {
      payroll = await api.getStaffPayroll(st.month);
    } catch (err) {
      body.insertAdjacentHTML("beforeend", `<p class="form-error">${escapeHtml(err.message)}</p>`);
      return;
    }
    const rows = payroll.rows;
    body.innerHTML = `
      ${monthBar(st.month)}
      ${rows.length > 1 ? `<div class="cf-sum st-sum">
        <div><span class="cf-sum-label">${t("st_total")}</span><strong>${nf(payroll.totals.total)}</strong></div>
        <div><span class="cf-sum-label">${t("st_paid")}</span><strong>${nf(payroll.totals.paid)}</strong></div>
        <div><span class="cf-sum-label">${t("st_balance")}</span><strong class="${payroll.totals.balance > 0 ? "cf-out" : "cf-in"}">${signed(payroll.totals.balance)}</strong></div>
      </div>` : ""}
      <div class="st-list">${rows.length ? rows.map(payRow).join("") : `<p class="muted">${t("st_none")}</p>`}</div>`;
    wireMonth();
    body.querySelectorAll("[data-person]").forEach((el) => el.addEventListener("click", () => goPerson(el.dataset.person)));
  }
  const payRow = (r) => `
    <button type="button" class="st-row" data-person="${r.id}">
      <span class="st-row-main">
        <strong>${escapeHtml(r.name)}</strong>
        <span class="muted st-row-sub">${escapeHtml(r.position)}${r.working_days ? ` · ${fill("st_days_paid", { n: r.paid_days, w: r.working_days })}` : ""}</span>
      </span>
      <span class="st-row-amt">
        <strong>${nf(r.total)}</strong>
        <small class="muted">${t("st_paid")} ${nf(r.paid)}</small>
        <small class="${r.balance > 0 ? "cf-out" : "cf-in"}">${t("st_balance")} ${signed(r.balance)}</small>
      </span>
    </button>`;
  function wireMonth() {
    body.querySelectorAll("[data-month]").forEach((b) =>
      b.addEventListener("click", () => {
        st.month = shiftMonth(st.month, Number(b.dataset.month));
        paint();
      })
    );
  }

  // -- people --
  function paintPeople() {
    const byId = new Map(people.map((p) => [p.id, p]));
    body.innerHTML = `
      <button type="button" class="btn btn-primary btn-block" id="st-add">${t("st_add_person")}</button>
      <div class="st-list">${people.length ? people
        .map(
          (p) => `<button type="button" class="st-row ${p.active ? "" : "st-row-off"}" data-edit="${p.id}">
            <span class="st-row-main"><strong>${escapeHtml(p.name)}</strong>
              <span class="muted st-row-sub">${escapeHtml(p.position)} · ${t(`st_kind_${p.kind}`)}${p.reports_to ? ` → ${escapeHtml(byId.get(p.reports_to)?.name ?? "")}` : ""}${p.active ? "" : ` · ${t("st_inactive")}`}</span></span>
            <span class="st-row-amt"><strong>${nf(p.fixed_salary_amd)}</strong></span>
          </button>`
        )
        .join("") : `<p class="muted">${t("st_none")}</p>`}</div>`;
    body.querySelector("#st-add").addEventListener("click", () => openPersonSheet(null));
    body.querySelectorAll("[data-edit]").forEach((el) => el.addEventListener("click", () => openPersonSheet(people.find((p) => String(p.id) === el.dataset.edit))));
  }

  // -- structure: the tree (admin > CEO > sales director > reps; warehouse; driver ...) --
  function paintTree() {
    if (!people.length) {
      body.innerHTML = `<p class="muted">${t("st_tree_empty")}</p>`;
      return;
    }
    const ids = new Set(people.map((p) => p.id));
    const kids = (id) => people.filter((p) => p.reports_to === id);
    // the roots: nobody above, or the boss is not visible to this user
    const roots = people.filter((p) => !p.reports_to || !ids.has(p.reports_to));
    const node = (p) => {
      const sub = kids(p.id);
      return `<li>
        <button type="button" class="st-node ${p.active ? "" : "st-row-off"}" data-person="${p.id}">
          <strong>${escapeHtml(p.name)}</strong><span class="muted">${escapeHtml(p.position)}</span>
        </button>${sub.length ? `<ul>${sub.map(node).join("")}</ul>` : ""}
      </li>`;
    };
    body.innerHTML = `<ul class="st-tree">${roots.map(node).join("")}</ul>`;
    body.querySelectorAll("[data-person]").forEach((el) => el.addEventListener("click", () => goPerson(el.dataset.person)));
  }

  // -- rules --
  async function paintRules() {
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    const s = await api.getStaffSettings();
    body.innerHTML = `
      <h2 class="section-title">${t("st_rules_title")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="st-rule-hint" aria-expanded="false" aria-controls="st-rule-text" aria-label="${t("more_info")}">!</span></h2>
      <p class="muted" id="st-rule-text" hidden>${t("st_min_visit_rule_hint")}</p>
      <label class="st-field">${t("st_min_visit_rule")}
        <input type="number" id="st-min-visit" min="1" max="100" step="1" inputmode="numeric" value="${s.min_visit_pct}" ${s.can_edit ? "" : "disabled"} /></label>
      ${s.can_edit ? `<button type="button" class="btn btn-primary btn-block" id="st-rule-save">${t("save")}</button>` : ""}
      <p class="form-error" id="st-rule-error" hidden></p>`;
    const hint = body.querySelector("#st-rule-hint");
    const text = body.querySelector("#st-rule-text");
    const toggle = () => {
      const open = hint.getAttribute("aria-expanded") === "true";
      hint.setAttribute("aria-expanded", String(!open));
      text.hidden = open;
    };
    hint.addEventListener("click", toggle);
    hint.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
    body.querySelector("#st-rule-save")?.addEventListener("click", async () => {
      const err = body.querySelector("#st-rule-error");
      err.hidden = true;
      try {
        await api.saveStaffSettings({ min_visit_pct: Number(body.querySelector("#st-min-visit").value) });
        showToast(t("st_saved"));
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    });
  }

  // -- add / edit a person --
  async function openPersonSheet(p) {
    const candidates = access.can_manage ? await api.getStaffCandidates().catch(() => []) : [];
    const loginOptions = [...(p?.user ? [{ id: p.user.id, name: p.user.name }] : []), ...candidates.filter((c) => c.id !== p?.user_id)];
    const bosses = people.filter((x) => x.id !== p?.id);
    const v = p ?? { name: "", position: "", pay_keys: [], kind: "rep", user_id: null, reports_to: null, channel: "", fixed_salary_amd: 0, visit_based: false, min_visit_pct: null, paid_dayoffs_per_month: 0, commission_basis: "none", commission_pct: 0, commission_channels: null, commission_excluded: [], start_date: "", end_date: "", active: true };
    const opt = (value, label, sel) => `<option value="${value}" ${sel ? "selected" : ""}>${escapeHtml(label)}</option>`;
    const overlay = openSheet(`
      <h2>${p ? t("st_edit_person") : t("st_add_person")}</h2>
      <form id="st-form" class="st-form">
        <label>${t("st_name")}<input name="name" required value="${escapeHtml(v.name)}" /></label>
        <label>${t("st_position")}<input name="position" required value="${escapeHtml(v.position)}" /></label>
        <p class="muted st-small">${t("st_position_hint")}</p>
        <label>${t("st_pay_keys")}<input name="pay_keys" value="${escapeHtml((v.pay_keys ?? []).join(", "))}" /></label>
        <label>${t("st_kind")}<select name="kind">${KINDS.map((k) => opt(k, t(`st_kind_${k}`), k === v.kind)).join("")}</select></label>
        <label>${t("st_login")}<select name="user_id">${opt("", t("st_login_none"), !v.user_id)}${loginOptions.map((u) => opt(u.id, u.name, u.id === v.user_id)).join("")}</select></label>
        <label>${t("st_reports_to")}<select name="reports_to">${opt("", t("st_reports_none"), !v.reports_to)}${bosses.map((b) => opt(b.id, `${b.name} · ${b.position}`, b.id === v.reports_to)).join("")}</select></label>
        <label>${t("st_channel")}<input name="channel" value="${escapeHtml(v.channel ?? "")}" /></label>
        <label>${t("st_fixed_salary")}<input name="fixed_salary_amd" inputmode="numeric" value="${v.fixed_salary_amd ? nf(v.fixed_salary_amd) : ""}" /></label>
        <label class="checkbox-row"><input type="checkbox" name="visit_based" ${v.visit_based ? "checked" : ""} /> ${t("st_visit_based")}</label>
        <label>${t("st_min_visit")}<input name="min_visit_pct" type="number" min="1" max="100" inputmode="numeric" value="${v.min_visit_pct ?? ""}" /></label>
        <label>${t("st_dayoffs")}<input name="paid_dayoffs_per_month" type="number" min="0" max="31" inputmode="numeric" value="${v.paid_dayoffs_per_month ?? 0}" /></label>
        <label>${t("st_commission_basis")}<select name="commission_basis">${["none", "collected", "sales"].map((k) => opt(k, t(`st_basis_${k}`), k === v.commission_basis)).join("")}</select></label>
        <label>${t("st_commission_pct")}<input name="commission_pct" type="number" min="0" max="100" step="0.1" inputmode="decimal" value="${v.commission_pct ?? 0}" /></label>
        <label>${t("st_commission_channels")}<input name="commission_channels" value="${escapeHtml((v.commission_channels ?? []).join(", "))}" /></label>
        <label>${t("st_commission_excluded")}<input name="commission_excluded" value="${escapeHtml((v.commission_excluded ?? []).join(", "))}" /></label>
        <label>${t("st_start")}<input name="start_date" type="date" value="${v.start_date ?? ""}" /></label>
        <label>${t("st_end")}<input name="end_date" type="date" value="${v.end_date ?? ""}" /></label>
        <label class="checkbox-row"><input type="checkbox" name="active" ${v.active ? "checked" : ""} /> ${t("st_active")}</label>
        <p class="form-error" id="st-form-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="st-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
        ${p ? `<button type="button" class="btn btn-block btn-danger" id="st-del">${t("st_delete")}</button>` : ""}
      </form>`);
    bindAmdInput(overlay.querySelector('[name="fixed_salary_amd"]'));
    overlay.querySelector("#st-cancel").addEventListener("click", () => overlay.remove());
    const errEl = overlay.querySelector("#st-form-error");
    const showError = (m) => ((errEl.textContent = m), (errEl.hidden = false));
    let armed = false;
    overlay.querySelector("#st-del")?.addEventListener("click", async (e) => {
      if (!armed) {
        armed = true;
        e.target.textContent = t("st_delete_confirm");
        return;
      }
      try {
        await api.deleteStaffPerson(p.id);
        overlay.remove();
        await loadPeople();
        paint();
      } catch (err) {
        showError(err.message);
      }
    });
    overlay.querySelector("#st-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const num = (k) => (f.get(k) === "" ? null : Number(f.get(k)));
      const data = {
        name: f.get("name"),
        position: f.get("position"),
        pay_keys: f.get("pay_keys"),
        kind: f.get("kind"),
        user_id: num("user_id"),
        reports_to: num("reports_to"),
        channel: f.get("channel"),
        fixed_salary_amd: parseAmd(f.get("fixed_salary_amd")) || 0,
        visit_based: f.get("visit_based") === "on",
        min_visit_pct: num("min_visit_pct"),
        paid_dayoffs_per_month: Number(f.get("paid_dayoffs_per_month")) || 0,
        commission_basis: f.get("commission_basis"),
        commission_pct: Number(f.get("commission_pct")) || 0,
        commission_channels: f.get("commission_channels"),
        commission_excluded: f.get("commission_excluded"),
        start_date: f.get("start_date") || null,
        end_date: f.get("end_date") || null,
        active: f.get("active") === "on",
      };
      const btn = e.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        if (p) await api.updateStaffPerson(p.id, data);
        else await api.createStaffPerson(data);
        overlay.remove();
        showToast(t("st_saved"));
        await loadPeople();
        paint();
      } catch (err) {
        showError(err.message);
        btn.disabled = false;
      }
    });
  }

  async function paint() {
    if (st.tab === "pay") return paintPay();
    if (!people.length) await loadPeople();
    if (st.tab === "people") return paintPeople();
    if (st.tab === "tree") return paintTree();
    if (st.tab === "rules") return paintRules();
  }

  try {
    await loadPeople();
  } catch (err) {
    body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  // An empty company: start where the first person is added.
  if (!people.length && tabs.includes("people") && st.tab === "pay") st.tab = "people";
  paintTabs();
  paint();
}

// ---- one person's month ------------------------------------------------------------------------------------------------------------
const STATE_CLASS = { paid: "ok", unpaid: "bad", dayoff_paid: "off-paid", dayoff_unpaid: "off-unpaid", future: "future", off: "none", outside: "none" };

async function renderPerson(root, navigate, id, month0, access) {
  let month = month0;
  root.innerHTML = `<div class="st-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;

  async function paint() {
    let d;
    try {
      d = await api.getStaffPay(id, month);
    } catch (err) {
      root.innerHTML = `<div class="st-view"><button type="button" class="btn" id="st-back">‹</button><p class="form-error">${escapeHtml(err.message)}</p></div>`;
      root.querySelector("#st-back").addEventListener("click", () => navigate("#/staff"));
      return;
    }
    const p = d.person;
    const line = (label, value, cls = "") => `<div class="st-line ${cls}"><span>${label}</span><strong>${value}</strong></div>`;
    const lead = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
    const cells = [...Array(lead).fill(`<span class="st-day st-day-blank"></span>`), ...d.days.map(dayCell)];
    root.innerHTML = `
      <div class="st-view">
        <div class="st-head"><button type="button" class="btn st-back" id="st-back" aria-label="${escapeHtml(t("back"))}">‹</button>
          <div><h1>${escapeHtml(p.name)}</h1><span class="muted">${escapeHtml(p.position)}</span></div></div>
        ${monthBar(month)}
        <div class="st-card">
          ${line(t("st_day_pay"), nf(d.day_pay))}
          <p class="muted st-small">${fill("st_days_paid", { n: d.paid_days, w: d.working_days })} · ${t("st_daily")} ${nf(d.daily_rate)}${d.day_pay_max !== d.day_pay ? `<br>${fill("st_day_pay_to_date", { a: nf(d.day_pay_to_date), b: nf(d.day_pay_max) })}` : ""}</p>
          ${p.commission_basis !== "none" ? line(`${t("st_commission")} <small class="muted">${fill("st_commission_line", { pct: d.commission.pct, base: nf(d.commission.base_amd) })}</small>`, nf(d.commission.amount)) : ""}
          ${d.premiums ? line(t("st_premiums"), nf(d.premiums)) : ""}
          ${d.bonuses ? line(t("st_bonuses"), nf(d.bonuses)) : ""}
          ${d.deductions ? line(t("st_deductions"), `−${nf(d.deductions)}`) : ""}
          ${line(t("st_total"), nf(d.total), "st-line-total")}
          ${line(`${t("st_paid_cashflow")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="st-paid-hint" aria-expanded="false" aria-controls="st-paid-text" aria-label="${t("more_info")}">!</span>`, nf(d.paid))}
          <p class="muted st-small" id="st-paid-text" hidden>${fill("st_paid_count", { n: d.payments })}. ${t("st_paid_hint")}</p>
          ${line(t("st_balance"), signed(d.balance), `st-line-total ${d.balance > 0 ? "cf-out" : "cf-in"}`)}
        </div>
        <h2 class="section-title">${t("st_calendar")}</h2>
        <div class="st-cal-head">${["1", "2", "3", "4", "5", "6", "7"].map((n) => `<span>${weekday(n)}</span>`).join("")}</div>
        <div class="st-cal" id="st-cal">${cells.join("")}</div>
        <div class="st-legend">${["paid", "unpaid", "dayoff_paid", "dayoff_unpaid"].map((s) => `<span><i class="st-dot st-dot-${STATE_CLASS[s]}"></i>${t(`st_state_${s}`)}</span>`).join("")}</div>
        <h2 class="section-title">${t("st_items")}</h2>
        <div id="st-items">${d.items.map((i) => `<div class="st-line"><span>${t(`st_item_${i.kind}`)}${i.note ? ` <small class="muted">${escapeHtml(i.note)}</small>` : ""}</span>
          <strong>${i.kind === "deduction" ? "−" : ""}${nf(i.amount_amd)}${d.can_manage ? ` <button type="button" class="st-x" data-del="${i.id}" aria-label="${escapeHtml(t("delete"))}">×</button>` : ""}</strong></div>`).join("")}</div>
        ${d.can_manage ? `<button type="button" class="btn btn-block" id="st-add-item">${t("st_add_item")}</button>` : ""}
        <p class="form-error" id="st-error" hidden></p>
      </div>`;
    wire(d);
  }

  const weekday = (n) => {
    const lang = getLang() === "hy" ? "hy-AM" : "en-GB";
    // 2024-01-01 is a Monday
    return new Intl.DateTimeFormat(lang, { weekday: "narrow", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, Number(n))));
  };

  function dayCell(day) {
    const cls = STATE_CLASS[day.state];
    const n = Number(day.date.slice(8));
    const sub = day.pct != null ? `${day.pct}%` : day.mark ? "✓" : "";
    return `<button type="button" class="st-day st-day-${cls}" data-day="${day.date}" data-state="${day.state}" aria-label="${escapeHtml(`${day.date} ${t(`st_state_${day.state}`)}`)}"><b>${n}</b><small>${sub}</small></button>`;
  }

  function wire(d) {
    root.querySelector("#st-back").addEventListener("click", () => navigate(`#/staff?month=${month}`));
    root.querySelectorAll("[data-month]").forEach((b) =>
      b.addEventListener("click", () => {
        month = shiftMonth(month, Number(b.dataset.month));
        paint();
      })
    );
    const hint = root.querySelector("#st-paid-hint");
    const text = root.querySelector("#st-paid-text");
    const toggle = () => {
      const open = hint.getAttribute("aria-expanded") === "true";
      hint.setAttribute("aria-expanded", String(!open));
      text.hidden = open;
    };
    hint.addEventListener("click", toggle);
    hint.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()));
    const errEl = root.querySelector("#st-error");
    const fail = (err) => ((errEl.textContent = err.message), (errEl.hidden = false));

    root.querySelectorAll(".st-day[data-day]").forEach((el) =>
      el.addEventListener("click", () => {
        const day = d.days.find((x) => x.date === el.dataset.day);
        if (day && day.state !== "off") openDaySheet(d, day);
      })
    );
    root.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          await api.deleteStaffItem(b.dataset.del);
          paint();
        } catch (err) {
          fail(err);
        }
      })
    );
    root.querySelector("#st-add-item")?.addEventListener("click", () => openItemSheet(fail));
  }

  function openDaySheet(d, day) {
    const info = day.planned ? fill("st_day_visits", { d: day.done, p: day.planned, pct: day.pct }) : t("st_day_noplan");
    const btn = (status, label, cls = "") => `<button type="button" class="btn btn-block ${cls}" data-status="${status}">${label}</button>`;
    const overlay = openSheet(`
      <h2>${escapeHtml(day.date)}</h2>
      <p class="muted">${t(`st_state_${day.state}`)} · ${info}</p>
      ${d.can_mark
        ? `<div class="st-day-actions">
            ${btn("completed", t("st_day_completed"), "btn-primary")}
            ${btn("dayoff", t("st_day_dayoff"))}
            ${btn("unpaid", t("st_day_unpaid"))}
            ${day.mark ? btn("clear", t("st_day_clear")) : ""}
          </div>
          <label class="st-field">${t("st_note")}<input id="st-day-note" maxlength="300" /></label>`
        : ""}
      <p class="form-error" id="st-day-error" hidden></p>
      <div class="sheet-actions"><button type="button" class="btn" id="st-day-close">${t("cancel")}</button></div>`);
    overlay.querySelector("#st-day-close").addEventListener("click", () => overlay.remove());
    overlay.querySelectorAll("[data-status]").forEach((b) =>
      b.addEventListener("click", async () => {
        const status = b.dataset.status === "clear" ? null : b.dataset.status;
        try {
          await api.markStaffDay(id, day.date, { status, note: overlay.querySelector("#st-day-note")?.value ?? "" });
          overlay.remove();
          paint();
        } catch (err) {
          const e = overlay.querySelector("#st-day-error");
          e.textContent = err.message;
          e.hidden = false;
        }
      })
    );
  }

  function openItemSheet(fail) {
    const overlay = openSheet(`
      <h2>${t("st_items")}</h2>
      <form id="st-item-form" class="st-form">
        <label>${t("st_kind")}<select name="kind">${["premium", "bonus", "deduction"].map((k) => `<option value="${k}">${t(`st_item_${k}`)}</option>`).join("")}</select></label>
        <label>${t("st_amount")}<input name="amount" inputmode="numeric" required /></label>
        <label>${t("st_note")}<input name="note" maxlength="300" /></label>
        <div class="sheet-actions">
          <button type="button" class="btn" id="st-item-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${t("save")}</button>
        </div>
      </form>`);
    bindAmdInput(overlay.querySelector('[name="amount"]'));
    overlay.querySelector("#st-item-cancel").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#st-item-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api.addStaffItem(id, { month, kind: f.get("kind"), amount_amd: parseAmd(f.get("amount")), note: f.get("note") });
        overlay.remove();
        paint();
      } catch (err) {
        overlay.remove();
        fail(err);
      }
    });
  }

  paint();
}
