// Stock count (Գույքագրում), owner 2026-10-30: the warehouse manager counts the day's part of the stock (every active product once a
// month, spread over the working days by the server: server/src/orders/stockCount.js). "Today": what is due (products carried over from
// earlier days first), one number field per product, saved when the field is left (Enter = next product), then "Finish the day".
// The counter counts blind (no Excel number until the day is closed); management sees the Excel number and the difference at once.
// "Month": every working day with its result and every difference found (management, and the counter for his own history).
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../util.js";
import { prepareSearchText, matchKind } from "../shared/searchKey.js";
import { installInlineClearButton } from "../searchBar.js";
import { enqueueStockCount, discardEntry, flushQueue, getQueue, onQueueChange } from "../offlineQueue.js";

const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key));
const shortDate = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const weekday = (day) => t(`stock_count_wd_${new Date(`${day}T00:00:00Z`).getUTCDay()}`);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
let lastDay = null; // the last answer: painted at once when the screen opens again
const CACHE_KEY = "fv_stock_count_day"; // the last answer of today's list, for a warehouse without signal

const readCache = () => {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return c?.items ? c : null;
  } catch {
    return null;
  }
};
const writeCache = (d) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(d));
  } catch {
    // storage full / blocked: the list just is not kept for offline use
  }
};
// counts typed without signal that are still waiting to be sent (offlineQueue.js, one per product and day)
const waiting = (day) => getQueue().filter((e) => e.type === "stock_count" && e.day === day);

function diffChip(item) {
  if (item.difference == null) return item.expected_qty != null ? `<span class="sc-excel">${t("stock_count_excel")} ${item.expected_qty}</span>` : "";
  const cls = item.difference === 0 ? "sc-diff-ok" : "sc-diff-bad";
  return `<span class="sc-excel">${t("stock_count_excel")} ${item.expected_qty ?? 0}</span><span class="sc-diff ${cls}">${item.difference === 0 ? "✓" : signed(item.difference)}</span>`;
}

function rowHtml(item, canCount) {
  const sub = [item.brand, item.size].filter(Boolean).map(escapeHtml).join(" · ");
  const pendingChip = item.pending ? `<span class="sc-pending">${t("stock_count_waiting_item")}</span>` : "";
  const value = item.counted ? String(item.counted_qty) : "";
  return `
    <li class="sc-row${item.counted ? " is-counted" : ""}" data-id="${item.product_id}">
      <div class="sc-name">
        <strong>${escapeHtml(item.name)}</strong>
        <span class="muted">${sub}${item.carried ? ` · <span class="sc-carried">${fill("stock_count_from_day", { d: shortDate(item.planned_date) })}</span>` : ""}</span>
        <span class="sc-chips">${pendingChip}${diffChip(item)}</span>
      </div>
      ${
        canCount
          ? `<div class="sc-entry">
              <input class="sc-qty" type="text" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off" aria-label="${escapeHtml(fill("stock_count_qty_for", { name: item.name }))}" value="${value}" data-saved="${value}">
              <button type="button" class="sc-undo" data-undo="${item.product_id}" aria-label="${t("stock_count_undo")}" ${item.counted ? "" : "hidden"}>×</button>
            </div>`
          : `<span class="sc-readonly text-amount">${item.counted ? item.counted_qty : "–"}</span>`
      }
    </li>`;
}

function dayHtml(data, query) {
  const canCount = data.can_count && !data.finished;
  const words = query.trim().split(/\s+/).filter(Boolean);
  const visible = data.items.filter((it) => {
    if (!words.length) return true;
    it._key ??= prepareSearchText(`${it.name} ${it.brand ?? ""} ${it.size ?? ""} ${it.family ?? ""}`);
    return words.every((w) => matchKind(it._key, w) > 0);
  });
  const groups = [
    { key: "carried", title: t("stock_count_group_carried"), items: visible.filter((i) => !i.counted && i.carried) },
    { key: "todo", title: t("stock_count_group_today"), items: visible.filter((i) => !i.counted && !i.carried) },
    { key: "done", title: t("stock_count_group_counted"), items: visible.filter((i) => i.counted) },
  ].filter((g) => g.items.length);
  if (!data.items.length) return `<p class="empty-state">${t("stock_count_nothing")}</p>`;
  if (!groups.length) return `<p class="empty-state">${t("stock_count_no_match")}</p>`;
  return groups
    .map((g) => `<h2 class="section-title sc-group-title">${g.title} <span class="muted">${g.items.length}</span></h2><ul class="sc-list sc-list-${g.key}">${g.items.map((i) => rowHtml(i, canCount)).join("")}</ul>`)
    .join("");
}

function headHtml(data) {
  const n = data.numbers;
  const pct = n.due ? Math.round((Math.min(n.counted, n.due) / n.due) * 100) : 100;
  const f = data.finished;
  const status = f
    ? f.left_over
      ? `<span class="badge badge-warning">${fill("stock_count_not_finished", { n: f.left_over })}</span>`
      : `<span class="badge badge-success">${t("stock_count_finished")}</span>`
    : "";
  return `
    <div class="sc-progress">
      <div class="sc-progress-line">
        <strong>${fill("stock_count_today_of", { done: n.counted, due: n.due })}</strong>
        ${status}
        <span class="muted sc-month-line">${fill("stock_count_month_of", { done: n.month_counted, total: n.month_total })}</span>
      </div>
      <span class="sc-track" aria-hidden="true"><span class="sc-track-fill" style="width:${pct}%"></span></span>
      ${f && f.differences ? `<p class="sc-result">${fill(f.task_id ? "stock_count_result_diffs" : "stock_count_result_diffs_only", { n: f.differences })}</p>` : ""}
      ${f && !f.differences && f.counted ? `<p class="sc-result">${t("stock_count_result_clean")}</p>` : ""}
    </div>`;
}

function monthHtml(m) {
  const stateBadge = (d) =>
    ({
      finished: `<span class="badge badge-success">${t("stock_count_state_finished")}</span>`,
      not_finished: `<span class="badge badge-warning">${t("stock_count_state_not_finished")}</span>`,
      open: `<span class="badge">${t("stock_count_state_open")}</span>`,
      future: `<span class="badge sc-badge-future">${t("stock_count_state_future")}</span>`,
      none: "",
    })[d.state];
  const days = m.days
    .filter((d) => d.state !== "none") // the days before the count started
    .map(
      (d) => `
      <li><button type="button" class="sc-day" ${d.state === "future" || d.state === "none" ? "disabled" : `data-day="${d.day}"`}>
        <span class="sc-day-date">${shortDate(d.day)} <span class="muted">${weekday(d.day)}</span></span>
        <span class="sc-day-nums">${d.state === "none" ? "–" : d.state === "future" ? fill("stock_count_planned_n", { n: d.planned }) : `${d.counted ?? 0}/${d.due ?? d.planned ?? 0}`}${d.differences ? ` · <span class="sc-diff sc-diff-bad">${fill("stock_count_diffs_n", { n: d.differences })}</span>` : ""}</span>
        ${stateBadge(d)}
      </button></li>`
    )
    .join("");
  const diffs = m.differences.length
    ? `<ul class="sc-list">${m.differences
        .map(
          (d) => `<li class="sc-row"><div class="sc-name"><strong>${escapeHtml(d.name)}</strong><span class="muted">${[d.brand, d.size].filter(Boolean).map(escapeHtml).join(" · ")} · ${shortDate(d.day)}${d.counted_by ? ` · ${escapeHtml(d.counted_by)}` : ""}</span>${d.note ? `<span class="muted">${escapeHtml(d.note)}</span>` : ""}</div>
            <div class="sc-month-diff"><span class="sc-excel">${t("stock_count_excel")} ${d.expected_qty}</span><span class="sc-excel">${t("stock_count_counted")} ${d.counted_qty}</span><span class="sc-diff sc-diff-bad">${signed(d.difference)}</span></div></li>`
        )
        .join("")}</ul>`
    : `<p class="empty-state">${t("stock_count_no_diffs")}</p>`;
  return `
    <p class="sc-month-total">${fill("stock_count_month_of", { done: m.totals.counted, total: m.totals.total })}</p>
    <div class="sc-month">
      <section><h2 class="section-title">${t("stock_count_days")}</h2><ul class="sc-days">${days}</ul></section>
      <section><h2 class="section-title">${t("stock_count_differences")} <span class="muted">${m.differences.length}</span></h2>${diffs}</section>
    </div>`;
}

export async function renderStockCount(root, navigate, query) {
  let tab = query?.get("tab") === "month" ? "month" : "day";
  let day = /^\d{4}-\d{2}-\d{2}$/.test(query?.get("day") ?? "") ? query.get("day") : null;
  root.innerHTML = `
    <div class="sc-view">
      <header class="sc-top">
        <h1 class="sc-title">${t("stock_count_title")}</h1>
        <div class="segmented sc-tabs" role="tablist">
          <button type="button" class="chip" role="tab" data-tab="day">${t("stock_count_tab_day")}</button>
          <button type="button" class="chip" role="tab" data-tab="month">${t("stock_count_tab_month")}</button>
        </div>
      </header>
      <div id="sc-head"></div>
      <div class="sc-search" id="sc-search-row"><input type="search" enterkeyhint="search" id="sc-search" placeholder="${t("stock_count_search")}" autocomplete="off"></div>
      <p class="form-error" id="sc-error" role="alert" hidden></p>
      <p class="sc-offline" id="sc-offline" role="status" hidden></p>
      <div id="sc-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="sc-bar" id="sc-bar" hidden>
        <p class="sc-bar-hint" id="sc-bar-hint"></p>
        <button type="button" class="btn btn-primary btn-block" id="sc-finish">${t("stock_count_finish")}</button>
      </div>
    </div>`;
  const view = root.querySelector(".sc-view");
  const head = view.querySelector("#sc-head");
  const body = view.querySelector("#sc-body");
  const bar = view.querySelector("#sc-bar");
  const hint = view.querySelector("#sc-bar-hint");
  const finishBtn = view.querySelector("#sc-finish");
  const errorEl = view.querySelector("#sc-error");
  const search = view.querySelector("#sc-search");
  installInlineClearButton(search);
  let data = null;
  let month = null;
  const offlineNote = view.querySelector("#sc-offline");
  let alive = true;
  let armed = false; // "Finish the day" with products left: the first tap says what happens, the second one finishes

  const showError = (msg) => {
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  };
  const setTabs = () => {
    view.classList.toggle("is-month", tab === "month");
    for (const b of view.querySelectorAll("[data-tab]")) {
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
      b.classList.toggle("chip-active", b.dataset.tab === tab);
    }
    view.querySelector("#sc-search-row").hidden = tab !== "day";
  };
  function paintBar() {
    const canFinish = tab === "day" && data?.can_count && !data.finished;
    bar.hidden = !canFinish;
    view.classList.toggle("has-bar", canFinish);
    if (!canFinish) return;
    const left = data.items.filter((i) => !i.counted).length;
    finishBtn.disabled = !data.items.some((i) => i.counted);
    hint.textContent = armed && left ? fill("stock_count_finish_confirm", { n: left }) : left ? fill("stock_count_left", { n: left }) : t("stock_count_all_counted");
    hint.classList.toggle("is-warning", armed && left > 0);
    finishBtn.textContent = armed && left ? t("stock_count_finish_anyway") : t("stock_count_finish");
  }
  function paintDay() {
    head.innerHTML = headHtml(data);
    // keep the field being typed in when the list is redrawn
    const focused = document.activeElement?.closest?.(".sc-row")?.dataset.id;
    body.innerHTML = dayHtml(data, search.value);
    if (focused) body.querySelector(`.sc-row[data-id="${focused}"] .sc-qty`)?.focus({ preventScroll: true });
    paintBar();
  }
  function paint() {
    setTabs();
    if (tab === "month") {
      head.innerHTML = "";
      bar.hidden = true;
      view.classList.remove("has-bar");
      body.innerHTML = month ? monthHtml(month) : `<p class="loading-state" role="status">${t("loading")}</p>`;
    } else if (data) paintDay();
  }

  // Shows the counts still waiting for signal as counted (marked "waiting to send") on top of what the server last said.
  function applyWaiting() {
    if (!data) return;
    const queued = new Map(waiting(data.day).map((e) => [e.productId, e]));
    for (const it of data.items) {
      const q = queued.get(it.product_id);
      if (q) Object.assign(it, { counted: true, counted_qty: q.qty, pending: true, difference: null });
      else if (it.pending) Object.assign(it, { pending: false, counted: false, counted_qty: null }); // it was sent, or taken back: the server's answer decides
    }
    data.numbers.counted = data.items.filter((i) => i.counted).length;
  }
  const setOffline = (on) => {
    offlineNote.hidden = !on;
    offlineNote.textContent = on ? t("stock_count_offline") : "";
  };
  async function loadDay() {
    try {
      const fresh = await api.getStockCountDay(day);
      if (!alive) return;
      data = fresh;
      if (!day) {
        lastDay = fresh;
        writeCache(fresh);
      }
      applyWaiting();
      setOffline(false);
      showError("");
      if (tab === "day") paintDay();
    } catch (err) {
      if (!alive) return;
      const cached = !day && err instanceof TypeError ? readCache() : null;
      if (cached) {
        // no signal: today's list as it was last seen, counting goes on and is sent later
        data = cached;
        applyWaiting();
        setOffline(true);
        showError("");
        if (tab === "day") paintDay();
      } else showError(err.message);
    }
  }
  async function loadMonth() {
    try {
      month = await api.getStockCountMonth();
      if (alive && tab === "month") paint();
    } catch (err) {
      if (alive) showError(err.message);
    }
  }

  async function save(input) {
    const row = input.closest(".sc-row");
    const id = Number(row.dataset.id);
    const raw = input.value.trim();
    if (raw === input.dataset.saved) return;
    const item = data.items.find((i) => i.product_id === id);
    if (raw === "") {
      input.value = input.dataset.saved; // emptying a field is not a count; "×" takes a count back
      return;
    }
    if (!/^\d{1,7}$/.test(raw)) {
      row.classList.add("is-error");
      showError(t("stock_count_bad_number"));
      return;
    }
    row.classList.remove("is-error");
    row.classList.add("is-saving");
    try {
      const r = await api.saveStockCount(id, Number(raw), null);
      input.dataset.saved = raw;
      if (!item.counted) data.numbers.month_counted += 1;
      Object.assign(item, { counted: true, counted_qty: r.counted_qty });
      if (r.difference != null) Object.assign(item, { expected_qty: r.expected_qty, difference: r.difference });
      row.classList.add("is-counted");
      row.querySelector(".sc-undo").hidden = false;
      row.querySelector(".sc-chips").innerHTML = diffChip(item);
      data.numbers.counted = data.items.filter((i) => i.counted).length;
      head.innerHTML = headHtml(data);
      armed = false;
      paintBar();
      showError("");
    } catch (err) {
      if (err instanceof TypeError) {
        // no signal: keep the count on the phone, it is sent as soon as there is signal again
        await enqueueStockCount({ productId: id, productName: item.name, qty: Number(raw), day: data.day });
        input.dataset.saved = raw;
        if (!item.counted) data.numbers.month_counted += 1;
        applyWaiting();
        paintDay();
        armed = false;
        showError("");
      } else {
        row.classList.add("is-error");
        showError(err.message);
      }
    } finally {
      row.classList.remove("is-saving");
    }
  }

  view.addEventListener("click", async (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn && tabBtn.dataset.tab !== tab) {
      tab = tabBtn.dataset.tab;
      paint();
      if (tab === "month") loadMonth();
      return;
    }
    const dayBtn = e.target.closest("[data-day]");
    if (dayBtn) {
      day = dayBtn.dataset.day === data?.today ? null : dayBtn.dataset.day;
      tab = "day";
      data = null;
      body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      setTabs();
      await loadDay();
      return;
    }
    const undo = e.target.closest("[data-undo]");
    if (undo) {
      const id = Number(undo.dataset.undo);
      try {
        const queued = waiting(data.day).find((e) => e.productId === id);
        if (queued) await discardEntry(queued.id); // never sent: just forget it
        else await api.clearStockCount(id);
        const item = data.items.find((i) => i.product_id === id);
        if (item.counted) data.numbers.month_counted -= 1;
        Object.assign(item, { counted: false, counted_qty: null, difference: null, pending: false });
        if (!data.shows_expected) delete item.expected_qty;
        data.numbers.counted = data.items.filter((i) => i.counted).length;
        armed = false;
        paintDay();
      } catch (err) {
        showError(err.message);
      }
    }
  });
  finishBtn.addEventListener("click", async () => {
    const left = data.items.filter((i) => !i.counted).length;
    if (left && !armed) {
      armed = true;
      paintBar();
      return;
    }
    finishBtn.disabled = true;
    try {
      // counts typed without signal must be on the server before the day is closed, or they would be lost to the carry-over
      if (waiting(data.day).length) {
        await flushQueue({ force: true });
        if (waiting(data.day).length) {
          showError(fill("stock_count_waiting_signal", { n: waiting(data.day).length }));
          finishBtn.disabled = false;
          return;
        }
      }
      data = await api.finishStockCountDay();
      armed = false;
      showError("");
      paintDay();
      window.dispatchEvent(new Event("warehouse-changed"));
    } catch (err) {
      showError(err instanceof TypeError ? t("stock_count_finish_offline") : err.message);
      finishBtn.disabled = false;
    }
  });
  body.addEventListener("focusout", (e) => {
    if (e.target.matches?.(".sc-qty")) save(e.target);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches(".sc-qty")) return;
    e.preventDefault();
    const all = [...body.querySelectorAll(".sc-qty")];
    const next = all[all.indexOf(e.target) + 1];
    if (next) next.focus();
    else e.target.blur();
  });
  body.addEventListener("input", (e) => {
    if (e.target.matches(".sc-qty")) e.target.value = e.target.value.replace(/\D/g, "").slice(0, 7);
  });
  search.addEventListener("input", () => data && paintDay());

  setTabs();
  if (tab === "day" && !day && (lastDay || readCache())) {
    data = lastDay || readCache();
    applyWaiting();
    paintDay();
  }
  // the phone sent the waiting counts (signal is back): show what the server now says
  // iPhone Safari does not always report "signal is back": while counts wait, try again on a timer and when the app comes to the front
  const retry = () => !document.hidden && waiting(data?.day ?? "").length && flushQueue();
  const retryTimer = setInterval(retry, 10000);
  document.addEventListener("visibilitychange", retry);
  let sent = waiting(data?.day ?? "").length;
  const stopWatching = onQueueChange(() => {
    const now = waiting(data?.day ?? "").length;
    if (now < sent && alive && navigator.onLine) loadDay();
    sent = now;
  });
  if (tab === "month") loadMonth();
  await loadDay();
  return () => {
    alive = false;
    stopWatching();
    clearInterval(retryTimer);
    document.removeEventListener("visibilitychange", retry);
  };
}
