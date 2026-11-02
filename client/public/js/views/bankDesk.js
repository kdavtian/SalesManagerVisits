// Bank & cash desks (payments redesign, release 2, owner 2026-11-02) -- the accountants' screen (admin and CEO too):
//   To check   statement lines the app could not give to a customer (unknown payer, several customers fit, a possible second copy) and cash
//              held by someone without a cash desk. One tap answers each: the customer (remembered for that payer next time), not a
//              customer payment, same money / separate payment.
//   Bank       every bank / card payment since the start date: how its customer was found, whether the statement confirmed it, whether
//              the Excel has it. Tap: the history, change the customer (with a reason), void (admin / CEO).
//   Cash desks each desk, who holds it and the cash on it that still waits to be handed over; admin adds and edits desks.
// "+ Payment" types a bank / card payment by hand (refused when it looks already recorded, until "separate payment"); "Statement"
// opens the bank statement upload of Cashflow, which now also records the customer payments.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { activateDialog, escapeHtml, formatDateDMY, showToast } from "../util.js";
import { icons } from "../icons.js";
import { installInlineClearButton } from "../searchBar.js";
import { prepareSearchText, matchKind } from "../shared/searchKey.js";

const nf = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key));
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yerevan" }).format(new Date());
const TABS = ["todo", "bank", "desks"];
let memo = { setup: null, todo: null, bank: null, desks: null }; // the last answers: painted at once when the screen opens again

function sheet(html, cls = "") {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet bd-sheet ${cls}">${html}</div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  return overlay;
}

/** Pick a customer (search on the server, 30 at a time). Resolves { id, name, erp_customer_id } or null. */
function pickCustomer(title, { suggested = null } = {}) {
  return new Promise((resolve) => {
    const overlay = sheet(`
      <h2>${escapeHtml(title)}</h2>
      <input type="search" id="bd-cust-q" placeholder="${escapeHtml(t("search_customers"))}" aria-label="${escapeHtml(t("search_customers"))}" autocomplete="off" />
      <div class="bd-cust-list" id="bd-cust-list"></div>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="bd-cust-cancel">${escapeHtml(t("cancel"))}</button></div>`);
    const done = (v) => {
      overlay.remove();
      resolve(v);
    };
    overlay.querySelector("#bd-cust-cancel").addEventListener("click", () => done(null));
    overlay.addEventListener("click", (e) => e.target === overlay && resolve(null));
    const q = overlay.querySelector("#bd-cust-q");
    installInlineClearButton(q);
    const list = overlay.querySelector("#bd-cust-list");
    let seq = 0;
    let shown = [];
    const paint = (rows) => {
      shown = rows;
      list.innerHTML = rows.length
        ? rows.map((c) => `<button type="button" class="bd-cust" data-id="${c.id}"><strong>${escapeHtml(c.name)}</strong>${c.erp_customer_id ? `<span class="muted">${escapeHtml(c.erp_customer_id)}</span>` : ""}</button>`).join("")
        : `<p class="empty-state">${escapeHtml(t("no_customers_found"))}</p>`;
    };
    async function search() {
      const mine = ++seq;
      const text = q.value.trim();
      try {
        const rows = await api.listCustomers(text ? { search: text, limit: 30 } : { limit: 30 });
        if (mine !== seq) return;
        paint(!text && suggested ? [suggested, ...rows.filter((c) => c.id !== suggested.id)] : rows);
      } catch (err) {
        if (mine === seq) list.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
      }
    }
    list.addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (b) done(shown.find((c) => c.id === Number(b.dataset.id)) ?? null);
    });
    let timer = null;
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 200);
    });
    if (suggested) paint([suggested]);
    search();
    q.focus();
  });
}

const howLabel = (p) => {
  if (p.source === "app") return p.line ? t("bd_how_typed_confirmed") : t("bd_how_typed");
  return t(`bd_how_${p.payer_match || "hand"}`);
};

// The "!" stays on the line of the title's last word (never alone on a line of its own, Armenian at 320 px).
function titleHtml() {
  const words = t("bd_title").split(" ");
  const last = words.pop();
  const icon = `<span role="button" tabindex="0" class="settings-inline-hint-icon" id="bd-hint-btn" aria-expanded="false" aria-controls="bd-hint" aria-label="${t("more_info")}">!</span>`;
  return `${escapeHtml(words.join(" "))} <span class="bd-nowrap">${escapeHtml(last)} ${icon}</span>`;
}

export async function renderBankDesk(root, navigate, query) {
  let tab = TABS.includes(query?.get("tab")) ? query.get("tab") : "todo";
  let search = "";
  root.innerHTML = `
    <div class="cf-view bd-view">
      <div class="cf-head">
        <h1>${titleHtml()}</h1>
        <div class="cf-head-actions">
          <button type="button" class="btn" id="bd-upload">${t("bd_statement")}</button>
          <button type="button" class="btn btn-primary" id="bd-add">${icons.plus}<span>${t("bd_add")}</span></button>
        </div>
      </div>
      <p class="muted cf-note" id="bd-hint" hidden>${t("bd_hint")}</p>
      <div class="cf-periods cf-tabs-even" role="tablist" id="bd-tabs"></div>
      <div id="bd-body" class="bd-body"></div>
      <p class="form-error" id="bd-error" hidden></p>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const errEl = $("#bd-error");
  const fail = (m) => ((errEl.textContent = m), (errEl.hidden = false));
  $("#bd-hint-btn").addEventListener("click", (e) => {
    const open = $("#bd-hint").hidden;
    $("#bd-hint").hidden = !open;
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });

  const todoCount = () => (memo.todo ? memo.todo.lines.length + memo.todo.no_desk.length : memo.setup?.unspecified ?? 0);
  function paintTabs() {
    const n = todoCount();
    $("#bd-tabs").innerHTML = TABS.map(
      (k) => `<button type="button" role="tab" aria-selected="${k === tab}" class="cf-period ${k === tab ? "cf-period-active" : ""}" data-tab="${k}">${escapeHtml(t(`bd_tab_${k}`))}${k === "todo" && n ? ` <span class="count-badge">${n}</span>` : ""}</button>`
    ).join("");
  }
  $("#bd-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    history.replaceState(null, "", `#/bank-desk${tab === "todo" ? "" : `?tab=${tab}`}`);
    paintTabs();
    paint();
    load(tab);
  });

  // ---- To check ----
  function lineHtml(l) {
    const reason =
      l.reason === "possible_copy"
        ? fill("bd_reason_copy", { day: formatDateDMY(l.copy_of?.day), customer: l.copy_of?.customer ?? "" })
        : l.reason === "ambiguous"
          ? t("bd_reason_ambiguous")
          : t("bd_reason_unknown");
    const sub = [l.description, l.reference].filter(Boolean).join(" · ");
    const actions =
      l.reason === "possible_copy"
        ? `<button type="button" class="btn" data-act="duplicate">${t("bd_same_money")}</button><button type="button" class="btn btn-primary" data-act="separate">${t("bd_separate")}</button>`
        : `${l.customer_id ? `<button type="button" class="btn btn-primary bd-suggest" data-act="suggested">${escapeHtml(fill("bd_its", { name: l.customer_name }))}</button>` : ""}
           <button type="button" class="btn ${l.customer_id ? "" : "btn-primary"}" data-act="customer">${t(l.customer_id ? "bd_other_customer" : "bd_choose_customer")}</button>
           <button type="button" class="btn" data-act="not_customer">${t("bd_not_customer")}</button>`;
    return `<div class="bk-line bd-line" data-id="${l.id}">
      <div class="bk-line-main">
        <div class="bd-line-text"><strong>${escapeHtml(l.counterparty || t("bd_no_payer"))}</strong>
          <div class="muted bk-line-sub">${escapeHtml(formatDateDMY(l.day))} · ${escapeHtml(l.account)}${sub ? ` · ${escapeHtml(sub)}` : ""}</div>
          <span class="badge badge-warning bd-reason">${escapeHtml(reason)}</span></div>
        <div class="bk-line-amt cf-in">+${nf(l.amount)}</div>
      </div>
      <div class="bk-actions bd-actions">${actions}</div>
    </div>`;
  }
  function todoHtml() {
    const d = memo.todo;
    if (!d) return `<p class="loading-state" role="status">${t("loading")}</p>`;
    if (!d.lines.length && !d.no_desk.length) return `<p class="empty-state">${t("bd_todo_empty")}</p>`;
    const desks = d.no_desk.map(
      (p) => `<div class="bk-line bd-line bd-nodesk"><div class="bk-line-main"><div class="bd-line-text"><strong>${escapeHtml(p.name || "—")}</strong>
        <div class="muted bk-line-sub">${escapeHtml(fill("bd_no_desk", { n: p.count }))}</div></div><div class="bk-line-amt">${nf(p.amount)}</div></div>
        ${memo.setup?.can_manage_desks ? `<div class="bk-actions"><button type="button" class="btn" data-go="desks">${t("bd_tab_desks")}</button></div>` : ""}</div>`
    );
    return `${desks.join("")}${d.lines.map(lineHtml).join("")}`;
  }

  async function answer(line, body, el) {
    el?.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const r = await api.resolvePay2Line(line.id, body);
      if (body.action === "not_customer" || body.action === "duplicate") {
        // a wrong tap is undone from the toast (no "are you sure?" dialogs): the line comes back to To check
        showToast(t("bd_done_saved"), {
          actionLabel: t("undo"),
          ms: 6000,
          onAction: () => api.resolvePay2Line(line.id, { action: "reopen" }).then(() => load("todo"), (x) => fail(x.message)),
        });
      } else showToast(r.confirmed ? t("bd_done_confirmed") : t("bd_done_recorded"));
      memo.todo.lines = memo.todo.lines.filter((l) => l.id !== line.id);
      memo.bank = null;
      paintTabs();
      paint();
    } catch (err) {
      fail(err.message);
      el?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }

  function chooseFor(line, el, suggested = null) {
    // the payer is remembered for that customer by default (next time automatic); a one-off payer can be left unremembered
    const overlay = sheet(`
      <h2>${escapeHtml(line.counterparty || t("bd_no_payer"))} · +${nf(line.amount)}</h2>
      <p class="muted">${escapeHtml(formatDateDMY(line.day))} · ${escapeHtml(line.account)}${line.description ? ` · ${escapeHtml(line.description)}` : ""}</p>
      <button type="button" class="btn btn-block bd-pick" id="bd-pick">${escapeHtml(suggested ? suggested.name : t("bd_choose_customer"))}</button>
      <label class="bd-check"><input type="checkbox" id="bd-remember" ${line.counterparty ? "checked" : "disabled"} /> <span>${escapeHtml(t("bd_remember"))}</span></label>
      <p class="form-error" id="bd-sheet-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="bd-x">${t("cancel")}</button><button type="button" class="btn btn-primary" id="bd-ok" ${suggested ? "" : "disabled"}>${t("bd_record")}</button></div>`);
    let picked = suggested;
    const pick = async () => {
      const c = await pickCustomer(t("bd_choose_customer"), { suggested: line.customer_id ? { id: line.customer_id, name: line.customer_name, erp_customer_id: line.customer_erp } : null });
      if (!c) return;
      picked = c;
      overlay.querySelector("#bd-pick").textContent = c.name;
      overlay.querySelector("#bd-ok").disabled = false;
    };
    overlay.querySelector("#bd-pick").addEventListener("click", pick);
    overlay.querySelector("#bd-x").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#bd-ok").addEventListener("click", async () => {
      overlay.remove();
      await answer(line, { action: "customer", customer_id: picked.id, remember: overlay.querySelector("#bd-remember").checked }, el);
    });
    if (!suggested) pick();
  }

  // ---- Bank ----
  function paymentHtml(p) {
    const books = p.books_state === "open" ? `<span class="badge badge-neutral">${t("bd_not_in_excel")}</span>` : `<span class="badge badge-success">${t("bd_in_excel")}</span>`;
    const voided = p.voided_at ? `<span class="badge badge-danger">${t("bd_voided")}</span>` : "";
    return `<button type="button" class="bk-line bd-pay ${p.voided_at ? "is-voided" : ""}" data-pay="${p.id}">
      <div class="bk-line-main"><div class="bd-line-text"><strong>${escapeHtml(p.customer)}</strong>
        <div class="muted bk-line-sub">${escapeHtml(formatDateDMY(p.day))} · ${escapeHtml(p.account || "—")}${p.method === "card" ? ` · ${t("bd_card")}` : ""} · ${escapeHtml(howLabel(p))}</div>
        <span class="bd-chips">${voided || books}</span></div>
      <div class="bk-line-amt">${nf(p.amount)}</div></div>
    </button>`;
  }
  function bankHtml() {
    if (!memo.bank) return `<p class="loading-state" role="status">${t("loading")}</p>`;
    const words = search.trim().split(/\s+/).filter(Boolean);
    const rows = memo.bank.filter((p) => {
      if (!words.length) return true;
      p._key ??= prepareSearchText(`${p.customer} ${p.erp ?? ""} ${p.account ?? ""} ${p.line?.counterparty ?? ""} ${p.amount}`);
      return words.every((w) => matchKind(p._key, w) > 0);
    });
    const total = rows.filter((p) => !p.voided_at).reduce((s, p) => s + p.amount, 0);
    return `<div class="bd-search"><input type="search" id="bd-q" value="${escapeHtml(search)}" placeholder="${escapeHtml(t("bd_search"))}" aria-label="${escapeHtml(t("bd_search"))}" autocomplete="off" /></div>
      <p class="muted bd-total">${escapeHtml(fill("bd_total", { n: rows.length, amount: nf(total) }))}</p>
      <div class="bk-list" id="bd-pays">${rows.length ? rows.map(paymentHtml).join("") : `<p class="empty-state">${t(memo.bank.length ? "bd_no_match" : "bd_bank_empty")}</p>`}</div>`;
  }

  async function openPayment(id) {
    const p = memo.bank.find((x) => x.id === id);
    const overlay = sheet(`<h2>${escapeHtml(p.customer)} · ${nf(p.amount)}</h2><div id="bd-pay-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <p class="form-error" id="bd-sheet-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating" id="bd-pay-actions"><button type="button" class="btn" id="bd-x">${t("done")}</button></div>`);
    overlay.querySelector("#bd-x").addEventListener("click", () => overlay.remove());
    const err = (m) => Object.assign(overlay.querySelector("#bd-sheet-error"), { textContent: m, hidden: false });
    let detail;
    try {
      detail = await api.getPay2Payment(id);
    } catch (e) {
      return err(e.message);
    }
    const ev = detail.events.map((e) => `<li><span class="muted">${escapeHtml(new Date(e.at).toLocaleString("en-GB", { timeZone: "Asia/Yerevan", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}</span> ${escapeHtml(t(`bd_ev_${e.kind}`) || e.kind)}${e.actor ? ` · ${escapeHtml(e.actor)}` : ""}${e.detail?.reason ? ` · ${escapeHtml(e.detail.reason)}` : ""}</li>`).join("");
    overlay.querySelector("#bd-pay-body").innerHTML = `
      <dl class="bd-facts">
        <dt>${t("bd_f_date")}</dt><dd>${escapeHtml(formatDateDMY(p.day))}</dd>
        <dt>${t("bd_f_account")}</dt><dd>${escapeHtml(p.account || "—")}${p.method === "card" ? ` · ${t("bd_card")}` : ""}</dd>
        <dt>${t("bd_f_found")}</dt><dd>${escapeHtml(howLabel(p))}</dd>
        ${p.line ? `<dt>${t("bd_f_line")}</dt><dd>${escapeHtml(formatDateDMY(p.line.day))} · ${escapeHtml([p.line.counterparty, p.line.description].filter(Boolean).join(" · "))}</dd>` : ""}
        <dt>${t("bd_f_excel")}</dt><dd>${escapeHtml(p.books_note || (p.books_state === "open" ? t("bd_not_in_excel") : t("bd_in_excel")))}</dd>
        ${p.voided_at ? `<dt>${t("bd_voided")}</dt><dd>${escapeHtml(p.void_reason || "")}</dd>` : ""}
      </dl>
      <h3 class="section-title">${t("bd_history")}</h3><ul class="bd-events">${ev}</ul>
      <div class="bd-inline" id="bd-inline" hidden></div>`;
    if (p.voided_at) return;
    const actions = overlay.querySelector("#bd-pay-actions");
    actions.insertAdjacentHTML("afterbegin", `${memo.setup?.can_void ? `<button type="button" class="btn btn-danger" id="bd-void">${t("bd_void")}</button>` : ""}<button type="button" class="btn" id="bd-move">${t("bd_change_customer")}</button>`);
    const inline = overlay.querySelector("#bd-inline");
    const askReason = (label, onSave, { button = t("save"), danger = false } = {}) => {
      inline.hidden = false;
      inline.innerHTML = `<label>${escapeHtml(label)}<input id="bd-reason" maxlength="300" autocomplete="off" /></label><button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"} btn-block" id="bd-reason-ok">${escapeHtml(button)}</button>`;
      const input = inline.querySelector("#bd-reason");
      input.focus();
      inline.querySelector("#bd-reason-ok").addEventListener("click", async (e) => {
        if (input.value.trim().length < 3) return err(t("bd_reason_needed"));
        e.currentTarget.disabled = true;
        try {
          await onSave(input.value.trim());
          overlay.remove();
          memo.bank = null;
          load("bank");
        } catch (x) {
          err(x.message);
          e.currentTarget.disabled = false;
        }
      });
    };
    overlay.querySelector("#bd-move").addEventListener("click", async () => {
      const c = await pickCustomer(t("bd_change_customer"));
      if (!c) return;
      askReason(fill("bd_move_reason", { name: c.name }), async (reason) => {
        await api.changePay2Customer(id, { customer_id: c.id, reason });
        showToast(t("bd_done_saved"));
      });
    });
    overlay.querySelector("#bd-void")?.addEventListener("click", () =>
      askReason(
        t("bd_void_reason"),
        async (reason) => {
          await api.voidPay2Payment(id, reason);
          showToast(t("bd_done_saved"));
          memo.todo = null;
        },
        { button: t("bd_void"), danger: true }
      )
    );
  }

  // ---- Cash desks ----
  function desksHtml() {
    const d = memo.desks;
    if (!d) return `<p class="loading-state" role="status">${t("loading")}</p>`;
    const manage = d.can_manage;
    const reps = d.reps_without_desk.length
      ? `<div class="bk-line bd-nodesk"><strong>${escapeHtml(fill("bd_reps_no_desk", { names: d.reps_without_desk.map((r) => r.name).join(", ") }))}</strong>
         ${manage ? `<div class="bk-actions"><button type="button" class="btn btn-primary" id="bd-auto">${t("bd_give_desks")}</button></div>` : ""}</div>`
      : "";
    const card = (k) => `<${manage ? "button type=\"button\"" : "div"} class="bk-line bd-desk ${k.active ? "" : "bd-desk-off"}" data-desk="${k.id}">
        <div class="bk-line-main"><div class="bd-line-text"><strong>${escapeHtml(k.name)}</strong>${k.active ? "" : ` <span class="badge badge-neutral">${t("bd_off")}</span>`}
          <div class="bd-holders">${k.holders.length ? k.holders.map((h) => `<span class="bd-holder">${escapeHtml(h.name)}</span>`).join("") : `<span class="muted">${t("bd_no_holder")}</span>`}</div></div>
        <div class="bd-desk-cash">${k.waiting_count ? `<span class="bk-line-amt">${nf(k.waiting_amd)}</span><span class="muted">${escapeHtml(fill("bd_waiting", { n: k.waiting_count }))}</span>` : ""}</div></div>
      </${manage ? "button" : "div"}>`;
    return `${reps}<div class="bk-list bd-desks">${d.desks.map(card).join("") || `<p class="empty-state">${t("bd_no_desks")}</p>`}</div>
      ${manage ? `<button type="button" class="btn btn-block" id="bd-new-desk">${icons.plus}<span>${t("bd_new_desk")}</span></button>` : ""}`;
  }

  function editDesk(desk) {
    const people = memo.desks.people;
    const chosen = new Set((desk?.holders ?? []).map((h) => h.id));
    const overlay = sheet(`
      <h2>${escapeHtml(desk ? desk.name : t("bd_new_desk"))}</h2>
      <label class="bd-field">${t("bd_desk_name")}<input id="bd-desk-name" maxlength="60" value="${escapeHtml(desk?.name ?? "")}" autocomplete="off" /></label>
      ${desk?.excel_aliases?.length ? `<p class="muted bd-aliases">${escapeHtml(fill("bd_aliases", { names: desk.excel_aliases.join(", ") }))}</p>` : ""}
      <p class="bd-field-label">${t("bd_holders")}</p>
      <input type="search" id="bd-people-q" placeholder="${escapeHtml(t("bd_search_people"))}" aria-label="${escapeHtml(t("bd_search_people"))}" autocomplete="off" />
      <div class="bd-people" id="bd-people"></div>
      ${desk ? `<label class="bd-check"><input type="checkbox" id="bd-desk-active" ${desk.active ? "checked" : ""} /> <span>${t("bd_desk_active")}</span></label>` : ""}
      <p class="form-error" id="bd-sheet-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="bd-x">${t("cancel")}</button><button type="button" class="btn btn-primary" id="bd-ok">${t("save")}</button></div>`);
    const q = overlay.querySelector("#bd-people-q");
    installInlineClearButton(q);
    const paintPeople = () => {
      const words = q.value.trim().split(/\s+/).filter(Boolean);
      const shown = people.filter((p) => chosen.has(p.id) || !words.length || words.every((w) => matchKind((p._key ??= prepareSearchText(`${p.name} ${t(`role_${p.role}`)}`)), w) > 0));
      overlay.querySelector("#bd-people").innerHTML = shown
        .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.name.localeCompare(b.name))
        .map((p) => `<label class="bd-person"><input type="checkbox" data-person="${p.id}" ${chosen.has(p.id) ? "checked" : ""} /><span>${escapeHtml(p.name)}</span><span class="muted">${escapeHtml(t(`role_${p.role}`))}</span></label>`)
        .join("");
    };
    overlay.querySelector("#bd-people").addEventListener("change", (e) => {
      const id = Number(e.target.dataset.person);
      if (e.target.checked) chosen.add(id);
      else chosen.delete(id);
    });
    q.addEventListener("input", paintPeople);
    paintPeople();
    overlay.querySelector("#bd-x").addEventListener("click", () => overlay.remove());
    overlay.querySelector("#bd-ok").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const body = { name: overlay.querySelector("#bd-desk-name").value, holder_ids: [...chosen] };
      if (desk) body.active = overlay.querySelector("#bd-desk-active").checked;
      try {
        if (desk) await api.updateCashDesk(desk.id, body);
        else await api.addCashDesk(body);
        overlay.remove();
        showToast(t("bd_done_saved"));
        load("desks");
      } catch (x) {
        Object.assign(overlay.querySelector("#bd-sheet-error"), { textContent: x.message, hidden: false });
        e.currentTarget.disabled = false;
      }
    });
  }

  // ---- + Payment (typed by hand) ----
  function addPayment() {
    const accounts = memo.setup?.bank_accounts ?? [];
    let customer = null;
    const clientRef = `bd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const overlay = sheet(`
      <h2>${t("bd_add_title")}</h2>
      <button type="button" class="btn btn-block bd-pick" id="bd-pick">${t("bd_choose_customer")}</button>
      <label class="bd-field">${t("bd_f_amount")}<input id="bd-amount" inputmode="numeric" autocomplete="off" placeholder="0" /></label>
      <div class="bd-two">
        <label class="bd-field">${t("bd_f_date")}<input type="date" id="bd-day" value="${todayYmd()}" min="${memo.setup?.cutover ?? ""}" max="${todayYmd()}" /></label>
        <label class="bd-field">${t("bd_f_how")}<select id="bd-method"><option value="bank">${t("bd_bank_transfer")}</option><option value="card">${t("bd_card")}</option></select></label>
      </div>
      <label class="bd-field">${t("bd_f_account")}<select id="bd-account">${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}</select></label>
      <label class="bd-field">${t("bd_f_note")}<input id="bd-note" maxlength="300" autocomplete="off" /></label>
      <div id="bd-dups" hidden></div>
      <p class="form-error" id="bd-sheet-error" hidden></p>
      <div class="sheet-actions sheet-actions-floating"><button type="button" class="btn" id="bd-x">${t("cancel")}</button><button type="button" class="btn btn-primary" id="bd-ok">${t("save")}</button></div>`);
    const $s = (s) => overlay.querySelector(s);
    const err = (m) => Object.assign($s("#bd-sheet-error"), { textContent: m, hidden: false });
    const amountEl = $s("#bd-amount");
    amountEl.addEventListener("input", () => {
      const digits = amountEl.value.replace(/\D/g, "").slice(0, 11);
      amountEl.value = digits ? Number(digits).toLocaleString("en-US") : "";
    });
    $s("#bd-pick").addEventListener("click", async () => {
      const c = await pickCustomer(t("bd_choose_customer"));
      if (!c) return;
      customer = c;
      $s("#bd-pick").textContent = c.name;
    });
    $s("#bd-x").addEventListener("click", () => overlay.remove());
    const save = async (separate) => {
      $s("#bd-sheet-error").hidden = true;
      if (!customer) return err(t("payment_customer_required"));
      const amount = Number(amountEl.value.replace(/\D/g, ""));
      if (!amount) return err(t("payment_amount_required"));
      if (!accounts.length) return err(t("bd_no_bank_accounts"));
      $s("#bd-ok").disabled = true;
      try {
        await api.recordPay2BankPayment({ customer_id: customer.id, amount, day: $s("#bd-day").value, account_id: Number($s("#bd-account").value), method: $s("#bd-method").value, note: $s("#bd-note").value, client_ref: separate ? `${clientRef}-s` : clientRef, separate });
        overlay.remove();
        showToast(t("bd_done_recorded"));
        memo.bank = null;
        memo.todo = null;
        load(tab);
      } catch (x) {
        $s("#bd-ok").disabled = false;
        if (x.status === 409 && x.body?.duplicates) {
          const box = $s("#bd-dups");
          box.hidden = false;
          box.innerHTML = `<p class="bd-dup-title">${t("bd_dup_title")}</p>${x.body.duplicates.map((d) => `<div class="bd-dup">${escapeHtml(formatDateDMY(d.day))} · ${nf(d.amount)} · ${escapeHtml(d.account || "")} · ${escapeHtml(t(d.source === "bank" ? "bd_from_statement" : "bd_how_typed"))}</div>`).join("")}
            <button type="button" class="btn btn-block" id="bd-separate">${t("bd_dup_separate")}</button>`;
          box.querySelector("#bd-separate").addEventListener("click", () => save(true));
        } else err(x.message);
      }
    };
    $s("#bd-ok").addEventListener("click", () => save(false));
  }

  // ---- painting and loading ----
  function paint() {
    errEl.hidden = true;
    const body = $("#bd-body");
    body.innerHTML = tab === "todo" ? todoHtml() : tab === "bank" ? bankHtml() : desksHtml();
    const q = body.querySelector("#bd-q");
    if (q) {
      installInlineClearButton(q);
      q.addEventListener("input", () => {
        search = q.value;
        const caret = q.selectionStart;
        paint();
        const again = $("#bd-q");
        again.focus();
        again.setSelectionRange(caret, caret);
      });
    }
  }
  $("#bd-body").addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) {
      tab = go.dataset.go;
      paintTabs();
      paint();
      return load(tab);
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      const el = act.closest(".bd-line");
      const line = memo.todo.lines.find((l) => l.id === Number(el.dataset.id));
      const a = act.dataset.act;
      if (a === "customer") return chooseFor(line, el);
      if (a === "suggested") return chooseFor(line, el, { id: line.customer_id, name: line.customer_name, erp_customer_id: line.customer_erp });
      return answer(line, { action: a }, el);
    }
    const pay = e.target.closest("[data-pay]");
    if (pay) return openPayment(Number(pay.dataset.pay));
    if (e.target.closest("#bd-new-desk")) return editDesk(null);
    if (e.target.closest("#bd-auto")) {
      return api.autoRepDesks().then((r) => (showToast(fill("bd_desks_made", { n: r.made })), load("desks")), (x) => fail(x.message));
    }
    const desk = e.target.closest("[data-desk]");
    if (desk && memo.desks?.can_manage) editDesk(memo.desks.desks.find((d) => d.id === Number(desk.dataset.desk)));
  });

  async function load(which) {
    try {
      if (which === "todo") memo.todo = await api.getPay2Unspecified();
      else if (which === "bank") memo.bank = (await api.getPay2BankPayments({ limit: 500 })).payments;
      else memo.desks = await api.getCashDesks();
      if (which === tab && root.isConnected) {
        paintTabs();
        if (!(which === "bank" && document.activeElement?.id === "bd-q")) paint();
      }
    } catch (err) {
      fail(err.message);
    }
  }

  $("#bd-add").addEventListener("click", addPayment);
  $("#bd-upload").addEventListener("click", async () => {
    try {
      const [{ openBankSheet }, meta] = await Promise.all([import("../bankStatements.js"), api.getCashMeta()]);
      await openBankSheet(meta, () => {
        memo.todo = null;
        memo.bank = null;
        load("todo");
        if (tab !== "todo") load(tab);
      });
    } catch (err) {
      fail(err.message);
    }
  });

  paintTabs();
  paint();
  try {
    memo.setup = await api.getPay2Setup();
  } catch (err) {
    fail(err.message);
  }
  paintTabs();
  await load(tab);
  if (tab !== "todo") load("todo");
  return () => {};
}
