// Cashflow (owner, 2026-10-23): every money movement of the company, the Excel Cashflow sheet inside the app.
// Phase 1: the ledger comes from Excel (bot push or the workbook uploaded here), shown structured and searchable: balances per account, money
// in / out per category (moves between our own accounts are not counted), and the list of movements. Admin / CEO / accountant / operations director.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, formatDateDMY, showToast, formatDuration } from "../util.js";
import { periodLabel, periodKey, periodAria, tapPeriod, periodDates } from "../periodButtons.js";

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
  const st = { base: "month", previous: false, all: false, q: "", account: "", category: "", kind: "" };
  let meta = null;
  let seq = 0;
  let entries = [];
  let total = 0;
  let hasMore = false;

  root.innerHTML = `
    <div class="cf-view">
      <div class="cf-head">
        <h1>${t("cf_title")} <span role="button" tabindex="0" class="settings-inline-hint-icon" id="cf-hint-btn" aria-expanded="false" aria-controls="cf-hint-text" aria-label="${t("more_info")}">!</span></h1>
      </div>
      <p class="muted cf-note" id="cf-hint-text" hidden>${t("cf_hint_internal")}</p>
      <div class="activity-tabs" role="tablist" id="cf-periods"></div>
      <div id="cf-summary"></div>
      <h2 class="section-title">${t("cf_accounts")}</h2>
      <div id="cf-accounts" class="cf-accounts"></div>
      <h2 class="section-title">${t("cf_categories")}</h2>
      <div id="cf-categories"></div>
      <h2 class="section-title">${t("cf_entries")}</h2>
      <div class="cf-filters">
        <input type="search" id="cf-q" placeholder="${escapeHtml(t("cf_search"))}" />
        <select id="cf-account" aria-label="${escapeHtml(t("cf_accounts"))}"></select>
        <select id="cf-category" aria-label="${escapeHtml(t("cf_categories"))}"></select>
      </div>
      <div id="cf-list"></div>
      <button type="button" class="btn btn-block" id="cf-more" hidden>${t("cf_more")}</button>
      <p class="muted cf-foot" id="cf-foot"></p>
      <button type="button" class="btn btn-block" id="cf-import" hidden>${t("cf_import")}</button>
      <input type="file" id="cf-file" accept=".xlsx,.xlsm" hidden />
      <p class="form-error" id="cf-error" hidden></p>
    </div>`;
  const $ = (id) => root.querySelector(id);
  const errorEl = $("#cf-error");

  const range = () => {
    if (st.all) return {};
    const d = periodDates(periodKey(st.base, st.previous), localToday());
    return d ? { from: d.from, to: d.to } : {};
  };
  const common = () => ({ ...range(), ...(st.account ? { account: st.account } : {}) });

  function paintPeriods() {
    $("#cf-periods").innerHTML =
      BASES.map((b) => {
        const active = !st.all && st.base === b;
        const prev = active && st.previous;
        return `<button role="tab" aria-selected="${active}" class="activity-tab ${active ? "activity-tab-active" : ""} ${prev ? "period-prev" : ""}" data-base="${b}" aria-label="${escapeHtml(active ? periodAria(b, prev) : periodLabel(b))}">${escapeHtml(periodLabel(b, prev))}</button>`;
      }).join("") + `<button role="tab" aria-selected="${st.all}" class="activity-tab ${st.all ? "activity-tab-active" : ""}" data-base="all">${t("cf_period_all")}</button>`;
  }

  function paintSummary(sum) {
    const net = sum.in_amd - sum.out_amd;
    $("#cf-summary").innerHTML = `
      <div class="cf-sum">
        <div><span class="cf-sum-label">${t("cf_in")}</span><strong class="cf-in">${nf(sum.in_amd)}</strong></div>
        <div><span class="cf-sum-label">${t("cf_out")}</span><strong class="cf-out">${nf(sum.out_amd)}</strong></div>
        <div><span class="cf-sum-label">${t("cf_net")}</span><strong class="${net >= 0 ? "cf-in" : "cf-out"}">${net < 0 ? "−" : ""}${nf(Math.abs(net))}</strong></div>
      </div>`;
  }

  function paintAccounts() {
    const rate = meta.usd_rate;
    const live = meta.accounts.filter((a) => a.balances.some((b) => Math.abs(b.balance) > 0.5));
    const totalAmd = live.reduce((s, a) => s + a.balances.reduce((x, b) => x + (b.currency === "USD" ? b.balance * (rate ?? 0) : b.balance), 0), 0);
    const card = (name, lines, klass = "") =>
      `<button type="button" class="cf-account ${klass}" ${klass.includes("total") ? "" : `data-account="${escapeHtml(name)}"`}><span class="cf-account-name">${escapeHtml(name)}</span>${lines.map((l) => `<span class="cf-account-bal ${l.neg ? "cf-out" : ""}">${escapeHtml(l.text)}</span>`).join("")}</button>`;
    $("#cf-accounts").innerHTML =
      card(t("cf_total_balance"), [{ text: `${totalAmd < 0 ? "−" : ""}${nf(Math.abs(totalAmd))}`, neg: totalAmd < 0 }], "cf-account-total") +
      live
        .map((a) => {
          const lines = a.balances.filter((b) => Math.abs(b.balance) > 0.5).map((b) => ({ text: `${b.balance < 0 ? "−" : ""}${money(Math.abs(b.balance), b.currency)}${b.currency === "USD" ? " USD" : ""}`, neg: b.balance < 0 }));
          return card(a.name, lines);
        })
        .join("");
    $("#cf-accounts").querySelectorAll("[data-account]").forEach((b) =>
      b.addEventListener("click", () => {
        const acc = meta.accounts.find((a) => a.name === b.dataset.account);
        st.account = st.account === String(acc.id) ? "" : String(acc.id);
        $("#cf-account").value = st.account;
        reload();
      })
    );
    $("#cf-account").innerHTML = `<option value="">${t("cf_all_accounts")}</option>${meta.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}`;
    $("#cf-account").value = st.account;
    $("#cf-category").innerHTML = `<option value="">${t("cf_all_categories")}</option>${KINDS.map((k) => `<optgroup label="${escapeHtml(t(`cf_kind_${k}`))}">${meta.categories.filter((c) => c.kind === k).map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</optgroup>`).join("")}`;
    $("#cf-category").value = st.category;
  }

  function paintCategories(sum) {
    $("#cf-categories").innerHTML = KINDS.map((k) => {
      const rows = sum.by_category.filter((c) => c.kind === k && (c.in_amd || c.out_amd));
      if (!rows.length) return "";
      const kin = rows.reduce((s, r) => s + r.in_amd, 0);
      const kout = rows.reduce((s, r) => s + r.out_amd, 0);
      return `<details class="cf-kind" ${k === "internal" ? "" : "open"}>
        <summary><span>${t(`cf_kind_${k}`)}</span><span class="cf-kind-total">${kin ? `<span class="cf-in">+${nf(kin)}</span>` : ""}${kout ? `<span class="cf-out">−${nf(kout)}</span>` : ""}</span></summary>
        ${rows
          .map((r) => `<button type="button" class="cf-cat ${String(r.id) === st.category ? "cf-cat-active" : ""}" data-category="${r.id}"><span>${escapeHtml(r.name)} <small class="muted">${r.n}</small></span><span>${r.in_amd ? `<span class="cf-in">+${nf(r.in_amd)}</span>` : ""}${r.out_amd ? `<span class="cf-out">−${nf(r.out_amd)}</span>` : ""}</span></button>`)
          .join("")}
      </details>`;
    }).join("");
    $("#cf-categories").querySelectorAll("[data-category]").forEach((b) =>
      b.addEventListener("click", () => {
        st.category = st.category === b.dataset.category ? "" : b.dataset.category;
        $("#cf-category").value = st.category;
        reloadList();
        loadSummary();
      })
    );
  }

  function rowHtml(e) {
    const neg = e.amount < 0;
    const who = e.customer_name || (e.erp_customer_id ? `#${e.erp_customer_id}` : "");
    const sub = [e.account, who, e.info || e.ref].filter(Boolean).join(" · ");
    return `<div class="cf-row">
      <div class="cf-row-main"><strong>${escapeHtml(e.category || "—")}</strong>${e.category_kind === "internal" ? `<span class="badge badge-neutral">${t("cf_kind_internal_short")}</span>` : ""}${e.origin !== "excel" ? `<span class="badge badge-info">${t("cf_manual")}</span>` : ""}<span class="muted cf-row-sub">${escapeHtml(sub)}</span></div>
      <div class="cf-row-amt ${neg ? "cf-out" : "cf-in"}">${neg ? "−" : "+"}${money(Math.abs(e.amount), e.currency)}${e.currency === "USD" ? `<small class="muted">${nf(Math.abs(e.amount_amd))}</small>` : ""}</div>
    </div>`;
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
    return { ...common(), ...(st.category ? { category: st.category } : {}), ...(st.q ? { q: st.q } : {}), limit: PAGE, offset };
  }

  async function reloadList() {
    const my = ++seq;
    try {
      const r = await api.getCashEntries(listParams(0));
      if (my !== seq) return;
      entries = r.entries;
      total = r.total;
      hasMore = r.has_more;
      paintList();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  let sumSeq = 0;
  async function loadSummary() {
    const my = ++sumSeq;
    const sum = await api.getCashSummary(common());
    if (my !== sumSeq) return;
    paintSummary(sum);
    paintCategories(sum);
  }

  async function reload() {
    errorEl.hidden = true;
    paintPeriods();
    const asOf = range().to;
    try {
      const [m] = await Promise.all([api.getCashMeta(asOf ? { as_of: asOf } : {}), loadSummary(), reloadList()]);
      meta = m;
      paintAccounts();
      paintFoot();
      $("#cf-import").hidden = !meta.can_edit;
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  }

  function paintFoot() {
    const s = meta.last_sync;
    const ago = s ? formatDuration(Math.round((Date.now() - new Date(s.at).getTime()) / 60000)) : "";
    $("#cf-foot").textContent = s ? fill("cf_synced", { t: ago, n: s.rows_in }) + (meta.usd_rate ? ` · ${fill("cf_usd_note", { rate: meta.usd_rate })}` : "") : t("cf_never_synced");
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
    if (btn.dataset.base === "all") Object.assign(st, { all: true, previous: false });
    else {
      const next = tapPeriod({ base: st.all ? "" : st.base, previous: st.previous }, btn.dataset.base);
      Object.assign(st, { all: false, base: next.base, previous: next.previous });
    }
    reload();
  });
  let qTimer;
  $("#cf-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      st.q = e.target.value.trim();
      reloadList();
    }, 250);
  });
  $("#cf-account").addEventListener("change", (e) => {
    st.account = e.target.value;
    reload();
  });
  $("#cf-category").addEventListener("change", (e) => {
    st.category = e.target.value;
    reloadList();
    loadSummary();
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
