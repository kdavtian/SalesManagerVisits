// Reports > Gaps and targets (owner, 2026-11-26): per product line the litres a month our customers could use minus what they buy from us
// (Excel, last 3 months), and the shops with potential whose fresh shelf shows no genuine Castrol. Management picks shops and taps
// "Create visit tasks": each shop's rep gets one "Offer Castrol" task for the next visit (never automatic, never twice while one is open).
// Server: reports/market/gaps.js.
import { api } from "../../api.js";
import { t, getLang } from "../../i18n.js";
import { escapeHtml, formatDateDMY, regionLabelHy, showToast } from "../../util.js";
import { nf, marketHeaderHtml, wireMarketHeader } from "./common.js";

export async function renderMarketGaps(root, navigate) {
  let line = "";
  let data = null;
  const picked = new Set();
  let seq = 0;
  root.innerHTML = `
    <div class="detail-view mkt-view">
      ${marketHeaderHtml("report_market_gaps_name")}
      <div id="report-body"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="mkt-action-bar" id="mkt-action" hidden>
        <button type="button" class="btn btn-primary btn-block" id="mkt-make-tasks"></button>
      </div>
    </div>`;
  wireMarketHeader(root, navigate, ["mkt_g_info_1", "mkt_g_info_2", "mkt_g_info_3", "mkt_g_info_4"]);
  const body = root.querySelector("#report-body");
  const bar = root.querySelector("#mkt-action");
  const makeBtn = root.querySelector("#mkt-make-tasks");
  const hy = getLang() === "hy";
  const unit = (u) => (u === "kg" ? t("mkt_kg") : t("mkt_l"));

  const paintAction = () => {
    bar.hidden = picked.size === 0;
    makeBtn.textContent = t("mkt_g_make_tasks").replace("{n}", String(picked.size));
  };

  const lineRow = (l) => `
    <button type="button" class="mkt-row mkt-line-row ${line === l.code ? "mkt-line-on" : ""}" data-line="${escapeHtml(l.code)}" aria-pressed="${line === l.code}">
      <span class="mkt-row-main"><strong>${escapeHtml(hy ? l.name_hy : l.name_en)}</strong>
        <small class="muted">${escapeHtml(t("mkt_g_line_meta").replace("{a}", nf(l.actual)).replace("{p}", nf(l.potential)).replace("{u}", unit(l.unit)).replace("{pct}", String(l.share_pct ?? 0)).replace("{n}", nf(l.customers)))}</small>
      </span>
      <span class="mkt-num">${nf(l.gap)}<small class="muted">${escapeHtml(t("mkt_g_gap_unit").replace("{u}", unit(l.unit)))}</small></span>
    </button>`;

  const shopRow = (s) => `
    <label class="mkt-row mkt-shop-row">
      <input type="checkbox" data-pick="${s.customer_id}" ${picked.has(s.customer_id) ? "checked" : ""} ${s.open_task || !s.rep_id ? "disabled" : ""} />
      <span class="mkt-row-main"><strong>${escapeHtml(s.name)}</strong>
        <small class="muted">${escapeHtml([s.region ? regionLabelHy(s.region) : "", s.rep_name || t("mkt_g_no_rep"), formatDateDMY(s.shelf_at)].filter(Boolean).join(" · "))}</small>
        <span class="mkt-flags">${
          s.open_task ? `<span class="badge badge-accent">${escapeHtml(t("mkt_g_task_open"))}</span>` : ""
        }${(s.castrol.length ? s.castrol : ["none"]).map((v) => `<span class="badge ${v === "fake" ? "badge-danger" : "badge-warning"}">${escapeHtml(v === "none" ? t("mkt_g_castrol_none") : t(`chip_castrol_${v}`))}</span>`).join("")}</span>
      </span>
      <span class="mkt-num">${nf(s.potential)}<small class="muted">${escapeHtml(t("mkt_g_month_unit"))}</small></span>
      <button type="button" class="icon-btn mkt-open" data-cid="${s.customer_id}" aria-label="${escapeHtml(t("mkt_g_open_customer"))}">›</button>
    </label>`;

  function render() {
    const pickable = data.shops.filter((s) => !s.open_task && s.rep_id);
    body.innerHTML = `
      <div class="card opp-totals">
        <div><span class="muted">${escapeHtml(t("opp_k_potential"))}</span><strong>${nf(data.totals.potential)}</strong></div>
        <div><span class="muted">${escapeHtml(t("opp_k_actual"))}</span><strong>${nf(data.totals.actual)} <small>${data.totals.share_pct ?? 0}%</small></strong></div>
        <div class="opp-gap"><span class="muted">${escapeHtml(t("opp_k_gap"))}</span><strong>${nf(data.totals.gap)}</strong></div>
        <div><span class="muted">${escapeHtml(t("mkt_g_no_castrol"))}</span><strong>${nf(data.shops.length)}</strong></div>
      </div>
      <p class="muted mkt-fresh">${escapeHtml(t("opp_note").replace("{span}", `${formatDateDMY(data.window.from)} – ${formatDateDMY(data.window.to)}`))}</p>
      <h2 class="section-title">${escapeHtml(t("mkt_g_by_line"))}</h2>
      ${data.lines.length ? `<div class="card mkt-list">${data.lines.map(lineRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("opp_empty"))}</p>`}
      <div class="mkt-section-head">
        <h2 class="section-title">${escapeHtml(data.line ? t("mkt_g_shops_line").replace("{line}", hy ? data.line.name_hy : data.line.name_en) : t("mkt_g_shops"))} <small class="muted">${nf(data.shops.length)}</small></h2>
        ${pickable.length ? `<button type="button" class="btn btn-sm" id="mkt-pick-all">${escapeHtml(t(pickable.every((s) => picked.has(s.customer_id)) ? "mkt_g_pick_none" : "mkt_g_pick_all"))}</button>` : ""}
      </div>
      ${data.shops_without_shelf ? `<p class="muted mkt-fresh">${escapeHtml(t("mkt_g_unknown").replace("{n}", nf(data.shops_without_shelf)).replace("{d}", String(data.fresh_days)))}</p>` : ""}
      ${data.shops.length ? `<div class="card mkt-list">${data.shops.map(shopRow).join("")}</div>` : `<p class="empty-state">${escapeHtml(t("mkt_g_no_shops"))}</p>`}`;
    body.querySelectorAll("[data-line]").forEach((b) =>
      b.addEventListener("click", () => {
        line = line === b.dataset.line ? "" : b.dataset.line;
        picked.clear();
        load();
      })
    );
    body.querySelectorAll("[data-pick]").forEach((c) =>
      c.addEventListener("change", () => {
        const id = Number(c.dataset.pick);
        if (c.checked) picked.add(id);
        else picked.delete(id);
        paintAction();
        const all = body.querySelector("#mkt-pick-all");
        if (all) all.textContent = t(pickable.every((s) => picked.has(s.customer_id)) ? "mkt_g_pick_none" : "mkt_g_pick_all");
      })
    );
    body.querySelector("#mkt-pick-all")?.addEventListener("click", () => {
      const allOn = pickable.every((s) => picked.has(s.customer_id));
      pickable.forEach((s) => (allOn ? picked.delete(s.customer_id) : picked.add(s.customer_id)));
      render();
    });
    body.querySelectorAll("[data-cid]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(`#/customers/${b.dataset.cid}`);
      })
    );
    paintAction();
  }

  async function load() {
    const my = ++seq;
    body.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    paintAction();
    try {
      const d = await api.getMarketGaps(line ? { line } : {});
      if (my !== seq) return;
      data = d;
      render();
    } catch (err) {
      if (my !== seq) return;
      body.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  makeBtn.addEventListener("click", async () => {
    if (!picked.size) return;
    makeBtn.disabled = true;
    try {
      const r = await api.createMarketGapTasks({ customer_ids: [...picked], line: line || null });
      showToast(t("mkt_g_made").replace("{n}", String(r.created)).replace("{o}", String(r.already_open)));
      picked.clear();
      await load();
    } catch (err) {
      showToast(err.message);
    } finally {
      makeBtn.disabled = false;
    }
  });

  await load();
}
