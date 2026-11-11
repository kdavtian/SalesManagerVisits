// Bank statements (Cashflow phase 3, owner 2026-10-24): upload the statement of one bank account (CSV / Excel), see which lines the ledger already has
// (matched), and for the lines it does not have: add them to Cashflow or ignore them. Excel stays the main ledger, so nothing is counted twice.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, escapeHtml, formatDateDMY, showToast } from "./util.js";

const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const money = (n, currency = "AMD") => (currency === "USD" ? `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : nf(n));
const FIELDS = ["date", "amount", "debit", "credit", "description", "counterparty", "reference", "currency", "balance", "type_code", "counterparty_account"];
const KINDS = ["income", "expense", "owner", "internal"];

export async function openBankSheet(meta, onChanged) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet bk-sheet">
      <h2>${escapeHtml(t("bk_title"))}</h2>
      <details class="bk-import" id="bk-import" open>
        <summary>${escapeHtml(t("bk_import"))}</summary>
        <label>${escapeHtml(t("cf_f_account"))}<select id="bk-account"><option value="">${escapeHtml(t("bk_account_detect"))}</option>${meta.accounts.filter((a) => a.active !== false).sort((a, b) => (a.kind === "bank" ? 0 : 1) - (b.kind === "bank" ? 0 : 1)).map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}</select></label>
        <label>${escapeHtml(t("bk_file"))}<span class="bk-file-btn btn btn-block"><span id="bk-file-name">${escapeHtml(t("bk_choose_file"))}</span><input type="file" id="bk-file" accept=".csv,.txt,.xlsx" /></span></label>
        <div id="bk-preview"></div>
        <p class="form-error" id="bk-error" hidden></p>
      </details>
      <details class="bk-import" id="bk-check">
        <summary>${escapeHtml(t("bk_check_title"))}</summary>
        <p class="muted">${escapeHtml(t("bk_check_hint"))}</p>
        <button type="button" class="btn btn-block" id="bk-check-run">${escapeHtml(t("bk_check_run"))}</button>
        <div id="bk-check-out"></div>
      </details>
      <div class="cf-periods cf-tabs-even" role="tablist" id="bk-tabs"></div>
      <div id="bk-list" class="bk-list"></div>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn btn-primary" id="bk-close">${escapeHtml(t("done"))}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  const $ = (s) => overlay.querySelector(s);
  $("#bk-close").addEventListener("click", () => overlay.remove());
  const errEl = $("#bk-error");
  const fail = (m) => ((errEl.textContent = m), (errEl.hidden = false));

  let state = "unmatched";
  let data = { counts: { matched: 0, unmatched: 0, added: 0, ignored: 0 }, lines: [], total: 0, imports: [] };
  let mapping = null;
  let changed = false;

  const tabs = [["unmatched", "bk_tab_check"], ["matched", "bk_tab_matched"], ["done", "bk_tab_done"]];
  const paintTabs = () => {
    const n = (k) => (k === "done" ? data.counts.added + data.counts.ignored : data.counts[k]);
    $("#bk-tabs").innerHTML = tabs.map(([k, key]) => `<button role="tab" aria-selected="${k === state}" class="cf-period ${k === state ? "cf-period-active" : ""}" data-tab="${k}">${escapeHtml(t(key))}${n(k) ? ` <span class="count-badge ${k === "unmatched" ? "" : "count-badge-quiet"}">${n(k)}</span>` : ""}</button>`).join("");
  };
  $("#bk-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    state = b.dataset.tab;
    paintTabs();
    paintList();
  });

  const lineHtml = (l) => {
    const neg = l.amount < 0;
    const sub = [l.counterparty, l.description, l.reference].filter(Boolean).join(" · ");
    const actions =
      l.state === "unmatched"
        ? `<div class="bk-actions"><button type="button" class="btn btn-primary" data-act="add">${escapeHtml(t("bk_add"))}</button><button type="button" class="btn" data-act="ignore">${escapeHtml(t("bk_ignore"))}</button></div>`
        : l.state === "ignored"
          ? `<div class="bk-actions"><button type="button" class="btn" data-act="reopen">${escapeHtml(t("bk_reopen"))}</button></div>`
          : "";
    const badge = l.state === "matched" ? `<span class="badge badge-success">${escapeHtml(t("bk_matched"))}${l.matched_category ? ` · ${escapeHtml(l.matched_category)}` : ""}</span>` : l.state === "added" ? `<span class="badge badge-info">${escapeHtml(t("bk_added"))}</span>` : l.state === "ignored" ? `<span class="badge badge-neutral">${escapeHtml(t("bk_ignored"))}</span>` : "";
    return `<div class="bk-line" data-id="${l.id}">
      <div class="bk-line-main"><div><strong>${escapeHtml(formatDateDMY(l.date))}</strong> ${badge}<div class="muted bk-line-sub">${escapeHtml(l.account)}${sub ? ` · ${escapeHtml(sub)}` : ""}</div></div>
      <div class="bk-line-amt ${neg ? "cf-out" : "cf-in"}">${neg ? "−" : "+"}${money(Math.abs(l.amount), l.currency)}</div></div>
      ${actions}<div class="bk-extra" hidden></div></div>`;
  };

  function paintList() {
    const shown = data.lines.filter((l) => (state === "done" ? l.state === "added" || l.state === "ignored" : l.state === state));
    $("#bk-list").innerHTML = shown.length ? shown.map(lineHtml).join("") : `<p class="muted">${escapeHtml(t(state === "unmatched" ? "bk_none_check" : "bk_none"))}</p>`;
  }

  async function load() {
    try {
      data = await api.getBankLines({ limit: 300 });
      paintTabs();
      paintList();
    } catch (err) {
      fail(err.message);
    }
  }

  // ---- upload: read the file (nothing saved), show what it holds, then import ----
  async function preview() {
    errEl.hidden = true;
    const file = $("#bk-file").files[0];
    if (!file) return;
    $("#bk-preview").innerHTML = `<p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`;
    try {
      const p = await api.previewBankStatement(file, $("#bk-account").value, mapping);
      // the statement named its account: the list follows it
      if (p.account && $("#bk-account").value !== String(p.account.id)) $("#bk-account").value = String(p.account.id);
      paintPreview(p, file);
    } catch (err) {
      $("#bk-preview").innerHTML = "";
      fail(err.body?.code === "wrong_account" ? t("bk_wrong_account") : err.message);
    }
  }
  const checkLine = (i) => {
    const date = i.date ? `${formatDateDMY(i.date)}: ` : "";
    return `${date}${t(`bk_check_${i.kind}`)} ${nf(i.expected)} ≠ ${nf(i.got)}`;
  };
  function paintPreview(p, file) {
    const cols = (sel) => `<option value="">—</option>${p.headers.map((h, i) => `<option value="${i}" ${p.mapping?.[sel] === i ? "selected" : ""}>${escapeHtml(h || `#${i + 1}`)}</option>`).join("")}`;
    const mappingHtml = p.needs_mapping
      ? `<p class="muted">${escapeHtml(t("bk_need_mapping"))}</p><div class="bk-map">${FIELDS.map((f) => `<label>${escapeHtml(t(`bk_col_${f}`))}<select data-map="${f}">${cols(f)}</select></label>`).join("")}</div><button type="button" class="btn" id="bk-remap">${escapeHtml(t("bk_read_again"))}</button>`
      : "";
    const st = p.statement ?? {};
    const header = st.number
      ? `<div class="bk-stmt"><div><strong>${escapeHtml(p.account?.name ?? st.holder ?? "")}</strong>${st.number ? ` · <span class="muted">${escapeHtml(st.number)}</span>` : ""}</div>
         ${st.period_from ? `<div class="muted">${escapeHtml(formatDateDMY(st.period_from))} – ${escapeHtml(formatDateDMY(st.period_to))}${st.opening_balance != null ? ` · ${escapeHtml(t("bk_balance_from_to").replace("{from}", nf(st.opening_balance)).replace("{to}", nf(st.closing_balance)))}` : ""}</div>` : ""}
         <div class="muted">${escapeHtml(t("bk_in_out").replace("{in}", nf(p.money_in)).replace("{out}", nf(p.money_out)))}</div></div>`
      : "";
    const accountNote = p.account_needed
      ? `<p class="form-error">${escapeHtml(t("bk_account_needed"))}</p>`
      : p.remember_number ? `<p class="muted">${escapeHtml(t("bk_account_remember").replace("{number}", st.number))}</p>` : "";
    const bad = p.checks?.ok === false;
    const checksHtml = p.checks?.ok === true
      ? `<p class="bk-check-ok">✓ ${escapeHtml(t("bk_checks_ok").replace("{n}", p.checks.compared))}</p>`
      : bad
        ? `<div class="bk-check-bad"><p><strong>${escapeHtml(t("bk_checks_bad"))}</strong></p><ul>${p.checks.items.slice(0, 6).map((i) => `<li>${escapeHtml(checkLine(i))}</li>`).join("")}</ul>
           <label class="bk-accept"><input type="checkbox" id="bk-accept" /> ${escapeHtml(t("bk_checks_accept"))}</label></div>`
        : "";
    $("#bk-preview").innerHTML = `
      ${header}${accountNote}${checksHtml}
      ${p.total ? `<p><strong>${p.total}</strong> ${escapeHtml(t("bk_lines"))} · ${escapeHtml(formatDateDMY(p.first_date))} – ${escapeHtml(formatDateDMY(p.last_date))}${p.already_imported ? ` · <span class="muted">${escapeHtml(t("bk_already").replace("{n}", p.already_imported))}</span>` : ""}${p.skipped_count ? ` · <span class="muted">${escapeHtml(t("bk_skipped").replace("{n}", p.skipped_count))}</span>` : ""}</p>
      <div class="bk-sample">${p.sample.map((l) => `<div><span>${escapeHtml(formatDateDMY(l.line_date))}</span><span class="muted bk-sample-text">${escapeHtml(l.counterparty || l.description || "")}</span><span class="${l.amount < 0 ? "cf-out" : "cf-in"}">${l.amount < 0 ? "−" : "+"}${money(Math.abs(l.amount), l.currency)}</span></div>`).join("")}</div>
      <button type="button" class="btn btn-primary btn-block" id="bk-do-import">${escapeHtml(t("bk_import_now").replace("{n}", p.total - p.already_imported))}</button>` : ""}
      ${mappingHtml}`;
    $("#bk-remap")?.addEventListener("click", () => {
      mapping = {};
      overlay.querySelectorAll("[data-map]").forEach((s) => s.value !== "" && (mapping[s.dataset.map] = Number(s.value)));
      preview();
    });
    const importBtn = $("#bk-do-import");
    const allowed = () => !p.account_needed || $("#bk-account").value !== "";
    const syncImport = () => importBtn && (importBtn.disabled = !allowed() || (bad && !$("#bk-accept")?.checked));
    $("#bk-accept")?.addEventListener("change", syncImport);
    syncImport();
    $("#bk-do-import")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api.importBankStatement(file, $("#bk-account").value, mapping, { acceptMismatch: bad && $("#bk-accept")?.checked });
        changed = true;
        $("#bk-file").value = "";
        $("#bk-file-name").textContent = t("bk_choose_file");
        const pay = r.payments && r.payments.recorded + r.payments.confirmed + r.payments.unspecified > 0
          ? `<p class="bk-result">${escapeHtml(t("bk_result_payments").replace("{recorded}", r.payments.recorded).replace("{confirmed}", r.payments.confirmed).replace("{unspecified}", r.payments.unspecified))}</p>`
          : "";
        $("#bk-preview").innerHTML = `<p class="bk-result">${escapeHtml(t("bk_result").replace("{new}", r.new_lines).replace("{matched}", r.matched).replace("{open}", r.unmatched))}</p>${pay}`;
        state = "unmatched";
        await load();
        onChanged?.();
      } catch (err) {
        fail(err.body?.code === "totals_mismatch" ? t("bk_checks_bad") : err.body?.code === "wrong_account" ? t("bk_wrong_account") : err.message);
        e.currentTarget.disabled = false;
      }
    });
  }
  $("#bk-file").addEventListener("change", () => {
    $("#bk-file-name").textContent = $("#bk-file").files[0]?.name || t("bk_choose_file");
    mapping = null;
    preview();
  });
  $("#bk-account").addEventListener("change", () => {
    if ($("#bk-file").files[0]) preview();
  });

  // ---- the two-way check against the Cashflow rows the accountant already booked ----
  const row = (date, amount, text) => `<div class="bk-check-row"><span>${escapeHtml(formatDateDMY(date))}</span><span class="muted bk-sample-text">${escapeHtml(text || "")}</span><span class="${amount < 0 ? "cf-out" : "cf-in"}">${amount < 0 ? "−" : "+"}${nf(Math.abs(amount))}</span></div>`;
  $("#bk-check-run").addEventListener("click", async () => {
    errEl.hidden = true;
    const account = $("#bk-account").value;
    if (!account) return fail(t("bk_check_choose"));
    $("#bk-check-out").innerHTML = `<p class="loading-state" role="status">${escapeHtml(t("loading"))}</p>`;
    try {
      const c = await api.getBankCheck(account);
      if (!c.period) {
        $("#bk-check-out").innerHTML = `<p class="muted">${escapeHtml(t("bk_none"))}</p>`;
        return;
      }
      const section = (key, items, render) => (items.length ? `<h4>${escapeHtml(t(key))} (${items.length})</h4>${items.slice(0, 40).map(render).join("")}${items.length > 40 ? `<p class="muted">…${items.length - 40}</p>` : ""}` : "");
      $("#bk-check-out").innerHTML = `
        <p><strong>${escapeHtml(formatDateDMY(c.period.from))} – ${escapeHtml(formatDateDMY(c.period.to))}</strong> · ${escapeHtml(t("bk_check_summary").replace("{lines}", c.counts.lines).replace("{matched}", c.counts.matched))}</p>
        ${c.counts.missing_in_excel + c.counts.excel_only + c.counts.near === 0 ? `<p class="bk-check-ok">✓ ${escapeHtml(t("bk_check_all_ok"))}</p>` : ""}
        ${section("bk_check_missing", c.missing_in_excel, (l) => row(l.date, l.amount, [l.counterparty, l.description].filter(Boolean).join(" · ")))}
        ${section("bk_check_excel_only", c.excel_only, (e) => row(e.date, e.amount, [e.category, e.info].filter(Boolean).join(" · ")))}
        ${section("bk_check_near", c.near, (n) => row(n.line.date, n.line.amount, `${n.line.counterparty || n.line.description || ""} ↔ ${formatDateDMY(n.entry.date)} (${n.days > 0 ? "+" : ""}${n.days} ${t("bk_days")})`))}`;
    } catch (err) {
      $("#bk-check-out").innerHTML = "";
      fail(err.message);
    }
  });

  // ---- decisions on a line ----
  $("#bk-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const el = btn.closest(".bk-line");
    const id = Number(el.dataset.id);
    const line = data.lines.find((l) => l.id === id);
    errEl.hidden = true;
    try {
      if (btn.dataset.act === "ignore") await api.ignoreBankLine(id);
      else if (btn.dataset.act === "reopen") await api.reopenBankLine(id);
      else if (btn.dataset.act === "add") return openAdd(el, line);
      showToast(t("cf_saved"));
      changed = true;
      await load();
      onChanged?.();
    } catch (err) {
      fail(err.message);
    }
  });

  // The category (and the customer, for money in) is the accountant's choice; the rest comes from the bank line.
  function openAdd(el, line) {
    const extra = el.querySelector(".bk-extra");
    extra.hidden = false;
    extra.innerHTML = `
      <label>${escapeHtml(t("cf_f_category"))}<select name="category_id">${KINDS.map((k) => `<optgroup label="${escapeHtml(t(`cf_kind_${k}`))}">${meta.categories.filter((c) => c.kind === k).map((c) => `<option value="${c.id}" ${c.id === line.suggested_category_id && line.suggested_confidence === "high" ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</optgroup>`).join("")}</select>${line.suggested_category_id ? `<span class="muted bk-suggest">${escapeHtml(t(line.suggested_confidence === "high" ? "bk_suggested_sure" : "bk_suggested"))}</span>` : ""}</label>
      ${line.amount > 0 ? `<label>${escapeHtml(t("cf_f_customer"))}<input name="erp_customer_id" inputmode="numeric" maxlength="40" /></label>` : ""}
      <label>${escapeHtml(t("cf_f_info"))}<input name="info" maxlength="300" value="${escapeHtml([line.counterparty, line.description].filter(Boolean).join(" - ").slice(0, 300))}" /></label>
      <div class="bk-actions"><button type="button" class="btn" data-x="cancel">${escapeHtml(t("cancel"))}</button><button type="button" class="btn btn-primary" data-x="save">${escapeHtml(t("save"))}</button></div>`;
    extra.querySelector('[data-x="cancel"]').addEventListener("click", () => (extra.hidden = true));
    extra.querySelector('[data-x="save"]').addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      const val = (n) => extra.querySelector(`[name="${n}"]`)?.value ?? "";
      try {
        await api.addBankLine(line.id, { category_id: Number(val("category_id")), erp_customer_id: val("erp_customer_id") || undefined, info: val("info") });
        showToast(t("cf_saved"));
        changed = true;
        await load();
        onChanged?.();
      } catch (err) {
        fail(err.message);
        ev.currentTarget.disabled = false;
      }
    });
  }

  await load();
  if (data.counts.unmatched || data.counts.matched || data.counts.added || data.counts.ignored) $("#bk-import").open = false;
  return () => changed;
}
