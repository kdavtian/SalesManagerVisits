// Handing chosen cash payments to the next person (owner, 2026-11-13: "allow cash handovers one by one (selected)"). One sheet for the
// Payments screen's "Hand over (n)" and the Cash handovers screen: who receives it, the money by direction and by day, then ONE explicit
// "Hand over" button. The server re-checks every payment (POST /api/cash-handoffs with payment_ids: the whole batch is refused when one of
// them is no longer this person's to give) and re-sums the amount itself.
import { api } from "./api.js";
import { escapeHtml, formatAmd, activateDialog, channelDisplayLabel, formatDayMonth } from "./util.js";
import { t } from "./i18n.js";

// The payment's day in Yerevan (UTC+4 all year), as YYYY-MM-DD: the day the server counts it in.
export const yerevanDayKey = (iso) => new Date(new Date(iso).getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);

// "Today" / "Yesterday" / "Wed, 12 Nov" for a payment's day.
export function dayHeadingLabel(iso) {
  const key = yerevanDayKey(iso);
  const today = yerevanDayKey(new Date().toISOString());
  const yesterday = yerevanDayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return t("home_today");
  if (key === yesterday) return t("yesterday");
  return formatDayMonth(new Date(`${key}T12:00:00`), { weekday: true });
}

// [{ key, label, rows }] in the order the rows come (they are already sorted by date)
export function groupByDay(rows, dateOf = (r) => r.payment_date) {
  const groups = [];
  for (const r of rows) {
    const key = yerevanDayKey(dateOf(r));
    if (groups.at(-1)?.key !== key) groups.push({ key, label: dayHeadingLabel(dateOf(r)), rows: [] });
    groups.at(-1).rows.push(r);
  }
  return groups;
}

export const sumAmd = (rows) => rows.reduce((n, r) => n + Number(r.amount_amd || 0), 0);

// Per direction: count and money (the receiver counts the notes direction by direction).
export function byChannel(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.sales_channel || "—";
    const e = map.get(key) ?? { sales_channel: key, count: 0, total_amd: 0 };
    e.count += 1;
    e.total_amd += Number(r.amount_amd || 0);
    map.set(key, e);
  }
  return [...map.values()].sort((a, b) => a.sales_channel.localeCompare(b.sales_channel));
}

export function channelBreakdownHtml(rowsByChannel, total) {
  if (!rowsByChannel?.length) return "";
  return `
    <table class="handoff-breakdown">
      <tbody>
        ${rowsByChannel
          .map(
            (c) => `<tr>
              <th scope="row">${escapeHtml(channelDisplayLabel(c.sales_channel))}</th>
              <td class="muted">${c.count}</td>
              <td class="text-amount">${formatAmd(c.total_amd)}</td>
            </tr>`
          )
          .join("")}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">${t("handoff_total")}</th>
          <td></td>
          <td class="text-amount"><strong>${formatAmd(total)}</strong></td>
        </tr>
      </tfoot>
    </table>
  `;
}

const roleLabel = (role) => t(`role_${role}`) || role;

// payments: the chosen rows ({ id, amount_amd, sales_channel, payment_date }); recipients: [{ id, name, role }] (the first is the
// default: the holder's own boss); onBehalfOf: the rep whose cash a director declares (first hop), else undefined.
// onStale: the server refused because a chosen payment is no longer this person's to give (handed over or approved meanwhile): the sheet
// closes and the screen reloads, so the next try starts from what is really there.
export function openHandoverSheet({ payments, recipients, onBehalfOf, onDone, onStale }) {
  const total = sumAmd(payments);
  const days = groupByDay(payments);
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.id = "handoff-confirm-overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>${t("handoff_confirm_submit_title")}</h2>
      ${
        recipients.length
          ? `<label for="handover-sheet-recipient">${t("handoff_give_to")}
              <select id="handover-sheet-recipient">
                ${recipients.map((r) => `<option value="${r.id}">${escapeHtml(r.name)} · ${escapeHtml(roleLabel(r.role))}</option>`).join("")}
              </select>
            </label>`
          : `<p class="form-error" style="position:static;">${t("handoff_no_recipients")}</p>`
      }
      <p class="handover-sheet-total"><strong>${t("handoff_items_n").replace("{n}", payments.length)}</strong> <strong class="text-amount">${formatAmd(total)}</strong></p>
      ${channelBreakdownHtml(byChannel(payments), total)}
      ${
        days.length > 1
          ? `<div class="handover-sheet-days">${days
              .map((d) => `<div class="handover-sheet-day"><span>${escapeHtml(d.label)}</span><span class="muted">${d.rows.length}</span><span class="text-amount">${formatAmd(sumAmd(d.rows))}</span></div>`)
              .join("")}</div>`
          : ""
      }
      <p class="muted">${t("handoff_confirm_submit_hint")}</p>
      <p class="form-error" id="handoff-confirm-error" hidden></p>
      <div class="sheet-actions">
        <button type="button" class="btn" id="handoff-confirm-cancel">${t("cancel")}</button>
        <button type="button" class="btn btn-primary" id="handoff-confirm-go" ${recipients.length ? "" : "disabled"}>${t("handoff_confirm_submit_yes")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#handoff-confirm-cancel").addEventListener("click", close);
  overlay.querySelector("#handoff-confirm-go").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const errorEl = overlay.querySelector("#handoff-confirm-error");
    errorEl.hidden = true;
    try {
      await api.createCashHandoff({
        to_user_id: Number(overlay.querySelector("#handover-sheet-recipient").value),
        payment_ids: payments.map((p) => p.id),
        on_behalf_of_user_id: onBehalfOf,
      });
      close();
      window.dispatchEvent(new Event("payments-changed"));
      await onDone?.();
    } catch (err) {
      if (err.status === 409 && onStale) {
        close();
        await onStale(err.message);
        return;
      }
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
}
