// Cashflow (owner, 2026-10-23): every money movement of the company, the Excel Cashflow sheet inside the app.
// Phase 1: the ledger comes from Excel (bot push or the workbook uploaded here), shown structured and searchable: balances per account, money
// in / out per category (moves between our own accounts are not counted), and the list of movements. Admin / CEO / accountant / operations director.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { activateDialog, activateCombobox, escapeHtml, formatDateDMY, formatDateTime, showToast, formatDuration, bindAmdInput, parseAmd } from "../util.js";
import { openBankSheet } from "../bankStatements.js";
import { periodLabel, periodKey, periodAria, tapPeriod, periodDates } from "../periodButtons.js";
import { openTriStateTreeSheet } from "../regionTree.js";
import { FILTER_ICONS } from "../filterIcons.js";
import { icons } from "../icons.js";
import { textMatches } from "../shared/searchKey.js";

const BASES = ["today", "week", "month", "quarter", "year"];
const KINDS = ["income", "expense", "owner", "internal"];
const PAGE = 50;

const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const money = (n, currency = "AMD") => (currency === "USD" ? `$${nf(n)}` : nf(n));
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function renderCashflow(root, navigate) {
  // dir: "" = all, "in" / "out" = the In / Out card tapped; custom = { from, to } when the calendar tab is chosen.
  const st = { base: "month", previous: false, all: false, custom: null, q: "", account: "", categories: [], dir: "" };
  let meta = null;
  let seq = 0;
  let entries = [];
  let hasMore = false;

  root.innerHTML = `
    <div class="cf-view">
      <div class="cf-head">
        <h1>${t("cf_title")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="cf-hint-btn" aria-expanded="false" aria-controls="cf-hint-text" aria-label="${t("more_info")}">!</span></h1>
        <div class="cf-head-actions">
          <button type="button" class="btn" id="cf-requests" hidden>${t("cf_requests")} <span class="count-badge" id="cf-requests-badge"></span></button>
          <button type="button" class="btn" id="cf-bank" hidden>${t("bk_btn")} <span class="count-badge" id="cf-bank-badge" hidden></span></button>
          <button type="button" class="btn btn-primary" id="cf-add" hidden>${t("cf_add")}</button>
        </div>
      </div>
      <p class="muted cf-note" id="cf-hint-text" hidden>${t("cf_hint_internal")}</p>
      <div class="cf-periods" role="tablist" id="cf-periods"></div>
      <div class="cf-custom" id="cf-custom" hidden>
        <label>${t("date_from")}<input type="date" id="cf-from" /></label>
        <label>${t("date_to")}<input type="date" id="cf-to" /></label>
      </div>
      <div id="cf-summary"></div>
      <div class="cf-body">
      <div class="cf-side">
      <h2 class="section-title">${t("cf_accounts")}</h2>
      <div id="cf-accounts" class="cf-accounts"></div>
      <h2 class="section-title">${t("cf_categories")}</h2>
      <div id="cf-categories"></div>
      </div>
      <div class="cf-main">
      <h2 class="section-title">${t("cf_entries")}</h2>
      <div class="activity-search-combined cf-search">
        <input type="search" id="cf-q" placeholder="${escapeHtml(t("cf_search"))}" aria-label="${escapeHtml(t("cf_search"))}" autocomplete="off" />
        <div class="activity-search-actions">
          <button type="button" class="activity-search-filter-btn" id="cf-cat-btn" aria-label="${escapeHtml(t("cf_filter_categories"))}" title="${escapeHtml(t("cf_filter_categories"))}">${FILTER_ICONS.category}<span class="activity-search-filter-dot" aria-hidden="true" hidden></span></button>
        </div>
      </div>
      <div id="cf-list"></div>
      <button type="button" class="btn btn-block" id="cf-more" hidden>${t("cf_more")}</button>
      <p class="muted cf-foot" id="cf-foot"></p>
      </div>
      </div>
      <button type="button" class="btn btn-block desk-inline" id="cf-import" hidden>${t("cf_import")}</button>
      <input type="file" id="cf-file" accept=".xlsx,.xlsm" hidden />
      <p class="form-error" id="cf-error" hidden></p>
    </div>`;
  const $ = (id) => root.querySelector(id);
  const errorEl = $("#cf-error");

  const range = () => {
    if (st.all) return {};
    if (st.custom) return st.custom.from && st.custom.to ? { from: st.custom.from, to: st.custom.to } : {};
    const d = periodDates(periodKey(st.base, st.previous), localToday());
    return d ? { from: d.from, to: d.to } : {};
  };
  const common = () => ({ ...range(), ...(st.account ? { account: st.account } : {}) });

  // -- the period row: Today .. Year, All, and a calendar tab for any other dates --
  function paintPeriods() {
    const tab = (key, active, label, aria, extra = "") =>
      `<button type="button" role="tab" aria-selected="${active}" class="cf-period ${active ? "cf-period-active" : ""} ${extra}" data-base="${key}" aria-label="${escapeHtml(aria)}">${label}</button>`;
    $("#cf-periods").innerHTML =
      BASES.map((b) => {
        const active = !st.all && !st.custom && st.base === b;
        const prev = active && st.previous;
        return tab(b, active, escapeHtml(periodLabel(b, prev)), active ? periodAria(b, prev) : periodLabel(b), prev ? "period-prev" : "");
      }).join("") +
      // "All" and the calendar share the last cell of the 3-column grid, so Armenian labels never push a lone button onto a 3rd line
      `<div class="cf-period-pair">${tab("all", st.all, escapeHtml(t("cf_period_all")), t("cf_period_all"))}${tab("custom", Boolean(st.custom), icons.calendar, t("cf_custom"), "cf-period-icon")}</div>`;
    $("#cf-custom").hidden = !st.custom;
    root.querySelector(".cf-period-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // -- In / Out / Net: three filter cards with the number of movements in the corner --
  function paintSummary(sum) {
    const net = sum.in_amd - sum.out_amd;
    const card = (dir, label, value, klass, n) =>
      `<button type="button" class="cf-sum-card ${st.dir === dir ? "cf-sum-active" : ""}" data-dir="${dir}" aria-pressed="${st.dir === dir}">
        <span class="cf-sum-top"><span class="cf-sum-label">${label}</span><span class="cf-sum-count" aria-label="${escapeHtml(fill("cf_count_aria", { n }))}">${nf(n)}</span></span>
        <strong class="${klass}">${value}</strong></button>`;
    $("#cf-summary").innerHTML = `<div class="cf-sum">
      ${card("in", t("cf_in"), nf(sum.in_amd), "cf-in", sum.n_in)}
      ${card("out", t("cf_out"), nf(sum.out_amd), "cf-out", sum.n_out)}
      ${card("", t("cf_net"), `${net < 0 ? "−" : ""}${nf(Math.abs(net))}`, net >= 0 ? "cf-in" : "cf-out", sum.n_in + sum.n_out)}
    </div>`;
  }

  // -- account cards: tap = only that account (marked), tap again or tap the total = every account --
  function paintAccounts() {
    const rate = meta.usd_rate;
    const live = meta.accounts.filter((a) => a.balances.some((b) => Math.abs(b.balance) > 0.5) || String(a.id) === st.account);
    const totalAmd = live.reduce((s, a) => s + a.balances.reduce((x, b) => x + (b.currency === "USD" ? b.balance * (rate ?? 0) : b.balance), 0), 0);
    const card = (id, name, lines, klass = "") => {
      const active = id === "" ? !st.account : String(id) === st.account;
      return `<button type="button" class="cf-account ${klass} ${active ? "cf-account-active" : ""}" data-account="${id}" aria-pressed="${active}"><span class="cf-account-name">${escapeHtml(name)}</span>${lines.map((l) => `<span class="cf-account-bal ${l.neg ? "cf-out" : ""}">${escapeHtml(l.text)}</span>`).join("")}</button>`;
    };
    $("#cf-accounts").innerHTML =
      card("", t("cf_total_balance"), [{ text: `${totalAmd < 0 ? "−" : ""}${nf(Math.abs(totalAmd))}`, neg: totalAmd < 0 }], "cf-account-total") +
      live
        .map((a) => {
          const lines = a.balances.filter((b) => Math.abs(b.balance) > 0.5).map((b) => ({ text: `${b.balance < 0 ? "−" : ""}${money(Math.abs(b.balance), b.currency)}${b.currency === "USD" ? " USD" : ""}`, neg: b.balance < 0 }));
          return card(a.id, a.name, lines.length ? lines : [{ text: "0" }]);
        })
        .join("");
    root.querySelector(".cf-account-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function paintCategories(sum) {
    const picked = new Set(st.categories.map(String));
    $("#cf-categories").innerHTML = KINDS.map((k) => {
      const rows = sum.by_category.filter((c) => c.kind === k && (c.in_amd || c.out_amd));
      if (!rows.length) return "";
      const kin = rows.reduce((s, r) => s + r.in_amd, 0);
      const kout = rows.reduce((s, r) => s + r.out_amd, 0);
      return `<details class="cf-kind" ${k === "internal" ? "" : "open"}>
        <summary><span>${t(`cf_kind_${k}`)}</span><span class="cf-kind-total">${kin ? `<span class="cf-in">+${nf(kin)}</span>` : ""}${kout ? `<span class="cf-out">−${nf(kout)}</span>` : ""}</span></summary>
        ${rows
          .map((r) => `<button type="button" class="cf-cat ${picked.has(String(r.id)) ? "cf-cat-active" : ""}" data-category="${r.id}" aria-pressed="${picked.has(String(r.id))}"><span>${escapeHtml(r.name)} <small class="muted">${r.n}</small></span><span>${r.in_amd ? `<span class="cf-in">+${nf(r.in_amd)}</span>` : ""}${r.out_amd ? `<span class="cf-out">−${nf(r.out_amd)}</span>` : ""}</span></button>`)
          .join("")}
      </details>`;
    }).join("");
  }

  function paintCategoryButton() {
    const btn = $("#cf-cat-btn");
    const on = st.categories.length > 0;
    btn.classList.toggle("activity-search-filter-btn-active", on);
    btn.querySelector(".activity-search-filter-dot").hidden = !on;
    btn.setAttribute("aria-label", on ? `${t("cf_filter_categories")} · ${fill("cf_cat_selected", { n: st.categories.length })}` : t("cf_filter_categories"));
  }

  function rowHtml(e) {
    const neg = e.amount < 0;
    const who = e.customer_name || (e.erp_customer_id ? `#${e.erp_customer_id}` : "");
    const sub = [e.account, who, e.info || e.ref].filter(Boolean).join(" · ");
    return `<button type="button" data-entry="${e.id}" class="cf-row">
      <div class="cf-row-main"><strong>${escapeHtml(e.category || "—")}</strong>${e.category_kind === "internal" ? `<span class="badge badge-neutral">${t("cf_kind_internal_short")}</span>` : ""}${e.origin !== "excel" ? `<span class="badge badge-info">${t("cf_manual")}</span>` : ""}${e.bank_ok ? `<span class="badge badge-success" title="${escapeHtml(t("bk_matched"))}">✓ ${t("bk_bank_ok")}</span>` : ""}<span class="muted cf-row-sub">${escapeHtml(sub)}</span></div>
      <div class="cf-row-amt ${neg ? "cf-out" : "cf-in"}">${neg ? "−" : "+"}${money(Math.abs(e.amount), e.currency)}${e.currency === "USD" ? `<small class="muted">${nf(Math.abs(e.amount_amd))}</small>` : ""}</div>
    </button>`;
  }

  function paintList() {
    const byDay = new Map();
    for (const e of entries) {
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    }
    $("#cf-list").innerHTML = entries.length
      ? [...byDay.entries()].map(([d, list]) => `<div class="cf-day"><div class="list-group-heading">${escapeHtml(formatDateDMY(d))}</div>${list.map(rowHtml).join("")}</div>`).join("")
      : `<p class="muted">${t("cf_none")}</p>`;
    $("#cf-more").hidden = !hasMore;
  }

  function listParams(offset = 0) {
    return {
      ...common(),
      ...(st.categories.length ? { categories: st.categories.join(",") } : {}),
      ...(st.q ? { q: st.q } : {}),
      ...(st.dir ? { dir: st.dir, real: "1" } : {}),
      limit: PAGE,
      offset,
    };
  }

  // The list and the In / Out / Net cards (the cards count everything filtered except the card itself).
  async function reloadList() {
    const my = ++seq;
    try {
      const r = await api.getCashEntries(listParams(0));
      if (my !== seq) return;
      entries = r.entries;
      hasMore = r.has_more;
      paintSummary(r);
      paintList();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  let sumSeq = 0;
  let lastSummary = null;
  async function loadSummary() {
    const my = ++sumSeq;
    const sum = await api.getCashSummary(common());
    if (my !== sumSeq) return;
    lastSummary = sum;
    paintCategories(sum);
  }

  async function reload() {
    errorEl.hidden = true;
    paintPeriods();
    paintCategoryButton();
    const asOf = range().to;
    try {
      const [m] = await Promise.all([api.getCashMeta(asOf ? { as_of: asOf } : {}), loadSummary(), reloadList()]);
      meta = m;
      paintAccounts();
      paintFoot();
      $("#cf-import").hidden = !meta.can_edit;
      $("#cf-add").hidden = !meta.can_edit;
      $("#cf-bank").hidden = !meta.can_edit;
      $("#cf-requests").hidden = !meta.pending_requests;
      $("#cf-requests-badge").textContent = String(meta.pending_requests || "");
      refreshBankBadge();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  // The red number on "Bank": statement lines that have no ledger row yet.
  async function refreshBankBadge() {
    if (!meta?.can_edit) return;
    try {
      const r = await api.getBankLines({ limit: 1 });
      const n = r.counts?.unmatched ?? 0;
      $("#cf-bank-badge").textContent = String(n);
      $("#cf-bank-badge").hidden = !n;
    } catch {
      /* the badge is a hint only */
    }
  }
  $("#cf-bank").addEventListener("click", () => openBankSheet(meta, () => reload()));

  function paintFoot() {
    const s = meta.last_sync;
    const ago = s ? formatDuration(Math.round((Date.now() - new Date(s.at).getTime()) / 60000)) : "";
    $("#cf-foot").textContent = s ? fill("cf_synced", { t: ago, n: s.rows_in }) + (meta.usd_rate ? ` · ${fill("cf_usd_note", { rate: meta.usd_rate })}` : "") : t("cf_never_synced");
  }

  // ---- one movement: details, history with date and time, edit / delete / request ---------------------------------------------------
  async function openDetails(id) {
    const overlay = openSheet(`<h2>${t("cf_details")}</h2><p class="loading-state" role="status">${t("loading")}</p>`);
    let d;
    try {
      d = await api.getCashEntry(id);
    } catch (err) {
      overlay.querySelector(".sheet").innerHTML = `<h2>${t("cf_details")}</h2><p class="form-error">${escapeHtml(err.message)}</p>`;
      return;
    }
    const e = d.entry;
    const line = (label, value) => (value ? `<div class="cf-d-line"><span class="muted">${escapeHtml(label)}</span><span>${value}</span></div>` : "");
    const logLine = (l) =>
      `<li><span class="cf-log-when">${escapeHtml(formatDateTime(l.at, { year: true }))}</span> · <strong>${escapeHtml(t(`cf_log_${l.action}`))}</strong>${l.user_name ? ` · ${escapeHtml(l.user_name)}` : ""}${l.note ? `<br /><small class="muted">${escapeHtml(l.note)}</small>` : ""}</li>`;
    const neg = e ? e.amount < 0 : false;
    overlay.querySelector(".sheet").innerHTML = e
      ? `<div class="cf-d-head"><h2>${escapeHtml(e.category || t("cf_details"))}</h2><span class="cf-chip-static">${escapeHtml(formatDateDMY(e.date))}</span></div>
        <p class="cf-d-amount ${neg ? "cf-out" : "cf-in"}">${neg ? "−" : "+"}${money(Math.abs(e.amount), e.currency)}${e.currency === "USD" ? ` USD <small class="muted">${nf(Math.abs(e.amount_amd))}</small>` : ""}</p>
        <div class="cf-d-lines">
          ${line(t("cf_d_account"), escapeHtml(e.account || ""))}
          ${line(t("cf_d_customer"), e.erp_customer_id ? `${escapeHtml(e.customer_name || "")} <span class="muted">#${escapeHtml(e.erp_customer_id)}</span>` : "")}
          ${line(t("cf_d_channel"), escapeHtml(e.sales_rep || ""))}
          ${line(t("cf_d_note"), escapeHtml(e.info || ""))}
          ${line(t("cf_d_ref"), escapeHtml(e.ref || ""))}
          ${line(t("cf_d_rate"), e.currency === "USD" && e.fx_rate ? escapeHtml(String(e.fx_rate)) : "")}
          ${line(t("cf_d_source"), escapeHtml(t(`cf_src_${e.origin}`)))}
        </div>
        ${e.customer_id ? `<button type="button" class="btn btn-block" id="cf-d-customer">${t("cf_open_customer")}</button>` : ""}
        ${d.pending_request ? `<p class="cf-d-pending">${escapeHtml(fill("cf_request_waiting", { a: t(`cf_req_${d.pending_request.action}`) }))}${d.pending_request.reason ? ` · ${escapeHtml(d.pending_request.reason)}` : ""}</p>` : ""}
        ${d.right === "request" && !d.pending_request ? `<p class="muted cf-d-hint">${escapeHtml(fill("cf_too_old_hint", { n: meta.edit_window_days }))}</p>` : ""}
        <h3 class="cf-d-subtitle">${t("cf_history")}</h3>
        <ul class="cf-log">${d.log.length ? d.log.map(logLine).join("") : `<li class="muted">${escapeHtml(e.origin === "excel" ? t("cf_src_excel") : formatDateTime(e.created_at, { year: true }))}</li>`}</ul>
        <p class="form-error" id="cf-d-error" hidden></p>
        <div class="cf-request-box" id="cf-req-box" hidden>
          <label>${t("cf_request_reason")}<input id="cf-req-reason" maxlength="300" /></label>
          <button type="button" class="btn btn-primary btn-block" id="cf-req-send">${t("cf_request_send")}</button>
        </div>
        <div class="sheet-actions cf-d-actions">
          <button type="button" class="btn" data-close>${t("close")}</button>
          ${d.right === "now" ? `<button type="button" class="btn btn-danger" id="cf-d-del">${t("cf_delete_short")}</button><button type="button" class="btn btn-primary" id="cf-d-edit">${t("cf_edit")}</button>` : ""}
          ${d.right === "request" && !d.pending_request ? `<button type="button" class="btn btn-danger" id="cf-d-reqdel">${t("cf_request_delete")}</button><button type="button" class="btn btn-primary" id="cf-d-reqedit">${t("cf_request_edit")}</button>` : ""}
        </div>`
      : `<h2>${t("cf_details")}</h2><ul class="cf-log">${d.log.map(logLine).join("")}</ul><div class="sheet-actions"><button type="button" class="btn" data-close>${t("close")}</button></div>`;
    const fail = (m) => {
      const el = overlay.querySelector("#cf-d-error");
      el.textContent = m;
      el.hidden = false;
    };
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#cf-d-customer")?.addEventListener("click", () => {
      overlay.remove();
      navigate(`#/customers/${e.customer_id}`);
    });
    overlay.querySelector("#cf-d-edit")?.addEventListener("click", () => {
      overlay.remove();
      openEntrySheet(e, "now");
    });
    overlay.querySelector("#cf-d-reqedit")?.addEventListener("click", () => {
      overlay.remove();
      openEntrySheet(e, "request");
    });
    let armed = false;
    overlay.querySelector("#cf-d-del")?.addEventListener("click", async (ev) => {
      if (!armed) {
        armed = true;
        ev.currentTarget.textContent = t("cf_delete_confirm");
        return;
      }
      try {
        await api.deleteCashEntry(e.id);
        overlay.remove();
        showToast(t("cf_saved"));
        await reload();
      } catch (er) {
        fail(er.message);
      }
    });
    overlay.querySelector("#cf-d-reqdel")?.addEventListener("click", () => {
      overlay.querySelector("#cf-req-box").hidden = false;
      overlay.querySelector("#cf-req-reason").focus();
    });
    overlay.querySelector("#cf-req-send")?.addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api.requestCashChange(e.id, { action: "delete", reason: overlay.querySelector("#cf-req-reason").value });
        overlay.remove();
        showToast(t("cf_request_sent"));
        await reload();
      } catch (er) {
        fail(er.message);
        ev.currentTarget.disabled = false;
      }
    });
  }

  // ---- requests waiting for management (management decides; the accountant sees their own) ----------------------------------------
  async function openRequests() {
    const overlay = openSheet(`<h2>${t("cf_requests")}</h2><div id="cf-req-list"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="sheet-actions"><button type="button" class="btn" data-close>${t("close")}</button></div>`);
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    const listEl = overlay.querySelector("#cf-req-list");
    const paint = async () => {
      const r = await api.getCashRequests();
      listEl.innerHTML = r.requests.length
        ? r.requests
            .map((q) => {
              const neg = q.amount < 0;
              return `<div class="cf-req">
                <button type="button" class="cf-row" data-open="${q.entry_id}">
                  <div class="cf-row-main"><strong>${escapeHtml(q.category || "—")} · ${escapeHtml(t(`cf_req_${q.action}`))}</strong>
                    <span class="muted cf-row-sub">${escapeHtml([formatDateDMY(q.date), q.account, q.info, q.requested_by_name, q.reason].filter(Boolean).join(" · "))}</span></div>
                  <div class="cf-row-amt ${neg ? "cf-out" : "cf-in"}">${q.amount == null ? "" : `${neg ? "−" : "+"}${money(Math.abs(q.amount), q.currency)}`}</div>
                </button>
                ${r.can_decide ? `<div class="cf-req-actions"><button type="button" class="btn" data-reject="${q.id}">${t("cf_reject")}</button><button type="button" class="btn btn-primary" data-approve="${q.id}">${t("cf_approve")}</button></div>` : ""}
              </div>`;
            })
            .join("")
        : `<p class="muted">${t("cf_requests_none")}</p>`;
    };
    listEl.addEventListener("click", async (ev) => {
      const open = ev.target.closest("[data-open]");
      const decide = ev.target.closest("[data-approve], [data-reject]");
      if (decide) {
        decide.disabled = true;
        try {
          await api.decideCashRequest(decide.dataset.approve || decide.dataset.reject, decide.dataset.approve ? "approve" : "reject");
          showToast(t("cf_decided"));
          await paint();
          reload();
        } catch (er) {
          showToast(er.status === 409 ? t("cf_request_stale") : er.message);
          decide.disabled = false;
        }
      } else if (open) openDetails(open.dataset.open);
    });
    try {
      await paint();
    } catch (er) {
      listEl.innerHTML = `<p class="form-error">${escapeHtml(er.message)}</p>`;
    }
  }

  // ---- add / edit (owner, 2026-10-27): Add + date chip / account + currency chips / amount / category chip / customer + channel / note -----
  let customersPromise = null;
  const loadCustomers = () => (customersPromise ??= api.getCashCustomers().then((r) => r.customers).catch(() => []));

  async function openEntrySheet(e = null, mode = "now") {
    await (meta ? null : reload());
    const catById = new Map(meta.categories.map((c) => [String(c.id), c]));
    const accById = new Map(meta.accounts.map((a) => [String(a.id), a]));
    const oil = meta.categories.find((c) => c.name.toLowerCase() === "oil order");
    const cash = meta.accounts.find((a) => a.name.toLowerCase() === "cash") ?? meta.accounts[0];
    const f = {
      date: e?.date ?? localToday(),
      account: String(e?.account_id ?? cash?.id ?? ""),
      currency: e?.currency ?? (/usd/i.test(cash?.name ?? "") ? "USD" : "AMD"),
      category: String(e?.category_id ?? oil?.id ?? meta.categories[0]?.id ?? ""),
      dir: e ? (e.amount < 0 ? "out" : "in") : null,
    };
    const kindOf = () => catById.get(f.category)?.kind ?? "expense";
    const isOil = () => (catById.get(f.category)?.name ?? "").toLowerCase() === "oil order";
    const isSalary = () => (catById.get(f.category)?.name ?? "").toLowerCase() === "salary";
    // income = money in, expense = money out; owner / between-our-accounts rows can go either way: only then the In / Out toggle shows.
    const dirOf = () => (kindOf() === "income" ? "in" : kindOf() === "expense" ? "out" : f.dir ?? "out");
    const title = mode === "request" ? t("cf_request_edit") : e ? t("cf_edit_entry") : t("cf_add");
    const overlay = openSheet(`
      <form id="cf-form" class="cf-form">
        <div class="cf-f-row cf-f-row1">
          <h2>${title}</h2>
          <label class="cf-chip cf-date-chip">${icons.calendar}<span id="cf-date-text"></span><input type="date" name="date" required value="${f.date}" aria-label="${escapeHtml(t("cf_f_date"))}" /></label>
        </div>
        <div class="cf-f-row cf-f-chips">
          <button type="button" class="cf-chip cf-chip-grow" id="cf-acc-chip"><span class="cf-chip-label">${t("cf_pick_account")}</span><strong id="cf-acc-text"></strong></button>
          <button type="button" class="cf-chip" id="cf-cur-chip"><span class="cf-chip-label">${t("cf_pick_currency")}</span><strong id="cf-cur-text"></strong></button>
        </div>
        <div id="cf-new-account" class="cf-f-row cf-f-chips" hidden>
          <input name="new_account" maxlength="60" placeholder="${escapeHtml(t("cf_f_name"))}" aria-label="${escapeHtml(t("cf_f_name"))}" />
          <select name="new_account_kind" aria-label="${escapeHtml(t("cf_f_account_kind"))}">${["cash", "bank", "credit", "other"].map((k) => `<option value="${k}">${t(`cf_account_kind_${k}`)}</option>`).join("")}</select>
        </div>
        <div class="cf-f-row cf-amount-row">
          <input name="amount" class="cf-amount" inputmode="decimal" required placeholder="${escapeHtml(t("cf_amount_ph"))}" aria-label="${escapeHtml(t("cf_f_amount"))}" value="${e ? nf(Math.abs(e.amount)) : ""}" />
          <span class="cf-amount-cur" id="cf-amount-cur"></span>
        </div>
        <label class="cf-f-row" id="cf-fx-row" hidden>${t("cf_f_rate")}<input name="fx_rate" inputmode="decimal" value="${e?.fx_rate ?? meta.usd_rate ?? ""}" /></label>
        <div class="cf-f-row cf-f-chips">
          <button type="button" class="cf-chip cf-chip-grow" id="cf-cat-chip"><span class="cf-chip-label">${t("cf_pick_category")}</span><strong id="cf-cat-text"></strong></button>
          <div class="cf-dir" id="cf-dir" role="group" hidden>
            <button type="button" data-dir="in">${t("cf_dir_in")}</button><button type="button" data-dir="out">${t("cf_dir_out")}</button>
          </div>
        </div>
        <div id="cf-new-category" class="cf-f-row cf-f-chips" hidden>
          <input name="new_category" maxlength="60" placeholder="${escapeHtml(t("cf_f_name"))}" aria-label="${escapeHtml(t("cf_f_name"))}" />
          <select name="new_category_kind" aria-label="${escapeHtml(t("cf_f_category_kind"))}">${KINDS.map((k) => `<option value="${k}" ${k === "expense" ? "selected" : ""}>${escapeHtml(t(`cf_kind_${k}`))}</option>`).join("")}</select>
        </div>
        <div id="cf-salary" class="cf-f-row cf-f-chips" hidden>
          <select name="staff" aria-label="${escapeHtml(t("cf_f_staff"))}"><option value="">${escapeHtml(t("cf_f_staff"))}</option></select>
          <input name="month" type="month" aria-label="${escapeHtml(t("cf_f_month"))}" value="${(e?.date ?? localToday()).slice(0, 7)}" />
        </div>
        <div class="cf-f-row cf-customer-row" id="cf-customer-row">
          <div class="erp-suggest-wrap cf-customer-wrap">
            <input name="erp_customer_id" id="cf-cust-input" maxlength="40" autocomplete="off" placeholder="${escapeHtml(t("cf_customer_search"))}" aria-label="${escapeHtml(t("cf_f_customer"))}" value="${escapeHtml(e?.erp_customer_id ?? "")}" />
            <div class="erp-suggest-list" id="cf-cust-list" hidden></div>
          </div>
          <input name="sales_rep" maxlength="40" class="cf-channel" placeholder="${escapeHtml(t("cf_d_channel"))}" aria-label="${escapeHtml(t("cf_channel_auto"))}" title="${escapeHtml(t("cf_channel_auto"))}" value="${escapeHtml(e?.sales_rep ?? "")}" />
        </div>
        <p class="cf-cust-name" id="cf-cust-name"></p>
        <input class="cf-f-row" name="info" maxlength="300" placeholder="${escapeHtml(t("cf_note_ph"))}" aria-label="${escapeHtml(t("cf_f_info"))}" value="${escapeHtml(e?.info ?? "")}" />
        ${mode === "request" ? `<label class="cf-f-row">${t("cf_request_reason")}<input name="reason" maxlength="300" /></label>` : ""}
        <p class="form-error" id="cf-form-error" hidden></p>
        <div class="sheet-actions sheet-actions-floating">
          <button type="button" class="btn" id="cf-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary">${mode === "request" ? t("cf_request_send") : t("save")}</button>
        </div>
      </form>`, "cf-entry-sheet");
    const form = overlay.querySelector("#cf-form");
    const el = form.elements;
    const err = overlay.querySelector("#cf-form-error");
    const fail = (m) => ((err.textContent = m), (err.hidden = false));
    bindAmdInput(el.amount);

    let customers = [];
    const custName = overlay.querySelector("#cf-cust-name");
    const paintCustomerName = () => {
      const id = el.erp_customer_id.value.trim();
      const c = id ? customers.find((x) => x.erp_customer_id === id) : null;
      custName.textContent = !isOil() ? "" : c ? c.name : id && customers.length ? t("cf_customer_unknown") : "";
      custName.classList.toggle("cf-cust-unknown", Boolean(id && !c && customers.length));
      return c;
    };

    const paint = () => {
      overlay.querySelector("#cf-date-text").textContent = formatDateDMY(el.date.value || f.date);
      overlay.querySelector("#cf-acc-text").textContent = f.account === "__new" ? t("cf_new_account") : accById.get(f.account)?.name ?? "—";
      overlay.querySelector("#cf-cur-text").textContent = f.currency;
      overlay.querySelector("#cf-amount-cur").textContent = f.currency === "USD" ? "USD" : "AMD";
      overlay.querySelector("#cf-cat-text").textContent = f.category === "__new" ? t("cf_new_category") : catById.get(f.category)?.name ?? "—";
      overlay.querySelector("#cf-fx-row").hidden = f.currency !== "USD";
      overlay.querySelector("#cf-new-account").hidden = f.account !== "__new";
      overlay.querySelector("#cf-new-category").hidden = f.category !== "__new";
      overlay.querySelector("#cf-salary").hidden = !isSalary();
      const twoWay = f.category === "__new" || ["owner", "internal"].includes(kindOf());
      const dirEl = overlay.querySelector("#cf-dir");
      dirEl.hidden = !twoWay;
      dirEl.querySelectorAll("[data-dir]").forEach((b) => b.classList.toggle("cf-dir-on", b.dataset.dir === dirOf()));
      // Customer ID: active for Oil order, a ghost otherwise (kept, not cleared, so switching back does not lose it)
      const oilRow = isOil();
      overlay.querySelector("#cf-customer-row").classList.toggle("cf-ghost", !oilRow);
      el.erp_customer_id.disabled = !oilRow;
      el.sales_rep.disabled = !oilRow;
      el.erp_customer_id.placeholder = oilRow ? t("cf_customer_search") : t("cf_customer_ghost");
      paintCustomerName();
    };
    paint();
    loadCustomers().then((list) => {
      customers = list;
      paintCustomerName();
    });

    el.date.addEventListener("change", paint);
    overlay.querySelector("#cf-acc-chip").addEventListener("click", async () => {
      const v = await pickOne(t("cf_pick_account"), [...meta.accounts.map((a) => ({ value: String(a.id), label: a.name })), { value: "__new", label: t("cf_new_account") }], f.account);
      if (v == null) return;
      f.account = v;
      // a USD account (ABB Bank USD, EvocaBank USD) means USD; any other account means AMD -- the chip can still change it
      if (v !== "__new") f.currency = /usd/i.test(accById.get(v)?.name ?? "") ? "USD" : "AMD";
      paint();
    });
    overlay.querySelector("#cf-cur-chip").addEventListener("click", async () => {
      const v = await pickOne(t("cf_pick_currency"), [{ value: "AMD", label: "AMD" }, { value: "USD", label: "USD" }], f.currency);
      if (v == null) return;
      f.currency = v;
      paint();
    });
    overlay.querySelector("#cf-cat-chip").addEventListener("click", async () => {
      const opts = KINDS.flatMap((k) => meta.categories.filter((c) => c.kind === k).map((c) => ({ value: String(c.id), label: c.name, group: t(`cf_kind_${k}`) })));
      const v = await pickOne(t("cf_pick_category"), [...opts, { value: "__new", label: t("cf_new_category") }], f.category);
      if (v == null) return;
      f.category = v;
      paint();
    });
    overlay.querySelector("#cf-dir").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-dir]");
      if (!b) return;
      f.dir = b.dataset.dir;
      paint();
    });

    // Customer ID: search by ID or name (like the ERP ID of a customer); choosing one fills the sales channel of its rep.
    const list = overlay.querySelector("#cf-cust-list");
    const suggest = () => {
      const q = el.erp_customer_id.value.trim().toLowerCase();
      const matches = (q ? customers.filter((c) => textMatches(`${c.erp_customer_id} ${c.name || ""}`, q)) : customers).slice(0, 30);
      list.innerHTML = matches
        .map((c) => `<div class="erp-suggest-item" data-id="${escapeHtml(c.erp_customer_id)}"><span>${escapeHtml(c.name || "")}</span><span class="muted">#${escapeHtml(c.erp_customer_id)}</span></div>`)
        .join("");
      list.hidden = !matches.length;
    };
    const fillChannel = () => {
      const c = paintCustomerName();
      if (c?.channel) el.sales_rep.value = c.channel;
    };
    el.erp_customer_id.addEventListener("focus", suggest);
    el.erp_customer_id.addEventListener("input", () => {
      suggest();
      fillChannel();
    });
    el.erp_customer_id.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
    activateCombobox(el.erp_customer_id, list, (item) => {
      el.erp_customer_id.value = item.dataset.id;
      fillChannel();
    });

    // salary: pick the person and the month, the note becomes "<position> YYYY MON" -- what Staff matches payments on
    let staff = [];
    api.getStaffPeople().then((r) => {
      staff = r.people.filter((p) => p.active);
      el.staff.innerHTML = `<option value="">${escapeHtml(t("cf_f_staff"))}</option>${staff.map((p) => `<option value="${p.id}">${escapeHtml(p.name)} · ${escapeHtml(p.position)}</option>`).join("")}`;
    }).catch(() => {});
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const composeSalary = () => {
      const p = staff.find((x) => String(x.id) === el.staff.value);
      const [y, m] = (el.month.value || "").split("-");
      if (p && y && m) el.info.value = `${p.position} ${y} ${MON[Number(m) - 1]}`;
    };
    el.staff.addEventListener("change", composeSalary);
    el.month.addEventListener("change", composeSalary);

    overlay.querySelector("#cf-cancel").addEventListener("click", () => overlay.remove());
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        let accountId = f.account;
        if (accountId === "__new") accountId = (await api.addCashAccount({ name: el.new_account.value, kind: el.new_account_kind.value })).id;
        let categoryId = f.category;
        if (categoryId === "__new") categoryId = (await api.addCashCategory({ name: el.new_category.value, kind: el.new_category_kind.value })).id;
        const oilRow = isOil();
        const data = {
          date: el.date.value, direction: f.category === "__new" ? f.dir ?? (el.new_category_kind.value === "income" ? "in" : "out") : dirOf(),
          amount: parseAmd(el.amount.value) || Number(String(el.amount.value).replace(/,/g, "")),
          currency: f.currency, fx_rate: f.currency === "USD" ? Number(el.fx_rate.value) : null,
          account_id: Number(accountId), category_id: Number(categoryId),
          erp_customer_id: oilRow ? el.erp_customer_id.value.trim() : "", sales_rep: oilRow ? el.sales_rep.value.trim() : e?.sales_rep ?? "", info: el.info.value,
        };
        if (mode === "request") {
          await api.requestCashChange(e.id, { action: "update", data, reason: el.reason.value });
          showToast(t("cf_request_sent"));
        } else {
          if (e) await api.updateCashEntry(e.id, data);
          else await api.addCashEntry(data);
          showToast(t("cf_saved"));
        }
        overlay.remove();
        await reload();
      } catch (er) {
        fail(er.message);
        btn.disabled = false;
      }
    });
  }

  // --- wiring ---
  const hintBtn = $("#cf-hint-btn");
  const hintText = $("#cf-hint-text");
  const toggleHint = () => {
    const open = hintBtn.getAttribute("aria-expanded") === "true";
    hintBtn.setAttribute("aria-expanded", String(!open));
    hintText.hidden = open;
  };
  hintBtn.addEventListener("click", toggleHint);
  hintBtn.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleHint()));
  $("#cf-periods").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-base]");
    if (!btn) return;
    const base = btn.dataset.base;
    if (base === "all") Object.assign(st, { all: true, previous: false, custom: null });
    else if (base === "custom") {
      // The calendar tab: the current window as the starting dates, then the two date fields change it.
      const r = range();
      st.custom = { from: r.from ?? localToday().slice(0, 8) + "01", to: r.to ?? localToday() };
      st.all = false;
      $("#cf-from").value = st.custom.from;
      $("#cf-to").value = st.custom.to;
    } else {
      const next = tapPeriod({ base: st.all || st.custom ? "" : st.base, previous: st.previous }, base);
      Object.assign(st, { all: false, custom: null, base: next.base, previous: next.previous });
    }
    reload();
  });
  const onCustom = () => {
    const from = $("#cf-from").value;
    const to = $("#cf-to").value;
    if (!from || !to) return;
    st.custom = from <= to ? { from, to } : { from: to, to: from };
    reload();
  };
  $("#cf-from").addEventListener("change", onCustom);
  $("#cf-to").addEventListener("change", onCustom);
  $("#cf-summary").addEventListener("click", (e) => {
    const card = e.target.closest("[data-dir]");
    if (!card) return;
    // In / Out filter the list; tapping the chosen one again, or Net, shows everything again
    st.dir = card.dataset.dir && st.dir !== card.dataset.dir ? card.dataset.dir : "";
    reloadList();
  });
  $("#cf-accounts").addEventListener("click", (e) => {
    const b = e.target.closest("[data-account]");
    if (!b) return;
    st.account = b.dataset.account === "" || st.account === b.dataset.account ? "" : b.dataset.account;
    reload();
  });
  $("#cf-categories").addEventListener("click", (e) => {
    const b = e.target.closest("[data-category]");
    if (!b) return;
    const id = Number(b.dataset.category);
    st.categories = st.categories.length === 1 && st.categories[0] === id ? [] : [id];
    paintCategoryButton();
    if (lastSummary) paintCategories(lastSummary);
    reloadList();
  });
  $("#cf-cat-btn").addEventListener("click", () => {
    if (!meta) return;
    const counts = new Map((lastSummary?.by_category ?? []).map((c) => [String(c.id), c.n]));
    const tree = KINDS.map((k, i) => {
      const cats = meta.categories.filter((c) => c.kind === k);
      return {
        key: `k${i}`,
        name: t(`cf_kind_${k}`),
        allIds: cats.map((c) => String(c.id)),
        customerCount: cats.reduce((s, c) => s + (counts.get(String(c.id)) ?? 0), 0),
        leaves: cats.map((c) => ({ id: String(c.id), name: `${c.name}${counts.get(String(c.id)) ? ` (${counts.get(String(c.id))})` : ""}` })),
        children: null,
      };
    }).filter((n) => n.leaves.length);
    openTriStateTreeSheet(t("cf_filter_categories"), {
      tree,
      initialSelectedIds: st.categories.map(String),
      countUnitLabel: t("cf_rows_unit"),
      totalLabel: (n) => fill("cf_cat_selected", { n }),
      searchPlaceholder: t("cf_search"),
      onApply: (ids) => {
        st.categories = [...ids].map(Number);
        paintCategoryButton();
        if (lastSummary) paintCategories(lastSummary);
        reloadList();
      },
    });
  });
  $("#cf-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-entry]");
    if (row) openDetails(row.dataset.entry);
  });
  let qTimer;
  $("#cf-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      st.q = e.target.value.trim();
      reloadList();
    }, 250);
  });
  $("#cf-more").addEventListener("click", async () => {
    const btn = $("#cf-more");
    btn.disabled = true;
    try {
      const r = await api.getCashEntries(listParams(entries.length));
      entries = entries.concat(r.entries);
      hasMore = r.has_more;
      paintList();
    } catch (err) {
      showToast(err.message);
    }
    btn.disabled = false;
  });
  $("#cf-add").addEventListener("click", () => openEntrySheet(null));
  $("#cf-requests").addEventListener("click", openRequests);
  $("#cf-import").addEventListener("click", () => $("#cf-file").click());
  $("#cf-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const btn = $("#cf-import");
    btn.disabled = true;
    btn.textContent = t("cf_importing");
    try {
      const r = await api.importCashWorkbook(file);
      showToast(fill("cf_import_done", { n: r.rows }));
      await reload();
    } catch (err) {
      showToast(err.message);
    }
    btn.disabled = false;
    btn.textContent = t("cf_import");
  });

  await reload();
}

function openSheet(html, klass = "") {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet ${klass}">${html}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (ev) => ev.target === overlay && overlay.remove());
  return overlay;
}

// A small list sheet for the chips of the Add sheet: resolves with the chosen value, or null when closed.
function pickOne(title, options, current) {
  return new Promise((resolve) => {
    let html = "";
    let group = null;
    for (const o of options) {
      if (o.group && o.group !== group) {
        group = o.group;
        html += `<div class="list-group-heading">${escapeHtml(group)}</div>`;
      }
      const on = o.value === current;
      html += `<button type="button" class="cf-pick ${on ? "cf-pick-on" : ""}" data-value="${escapeHtml(o.value)}" aria-pressed="${on}"><span>${escapeHtml(o.label)}</span>${on ? "<span aria-hidden=\"true\">✓</span>" : ""}</button>`;
    }
    const overlay = openSheet(`<h2>${escapeHtml(title)}</h2><div class="cf-pick-list">${html}</div>`, "cf-pick-sheet");
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    overlay.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-value]");
      if (b) done(b.dataset.value);
      else if (ev.target === overlay) resolve(null);
    });
    overlay.querySelector(".cf-pick-on")?.scrollIntoView({ block: "center" });
  });
}
