// Customer card > "Documents for signature" (e-signature engine, owner 2026-11-13): what KAD Motors sent this customer's KAD OS to sign, with
// its state, and a small "Send agreement" button while the customer has a KAD OS link and no agreement yet. Management and the accountant
// only (canManagePartnerDocuments); a customer without KAD OS and without documents shows nothing. The signed PDFs are also in the card's
// Files (kind "Signed in KAD OS"), which the rep sees too.
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml } from "../../util.js";
import { state } from "../../state.js";
import { canManagePartnerDocuments } from "../../shared/roles.js";

export async function paintCustomerSignDocs(slot, customerId) {
  if (!slot || !canManagePartnerDocuments(state.user?.role)) return;
  let data;
  try {
    data = await api.customerSignDocuments(customerId);
  } catch {
    return; // a side block: the card works without it
  }
  if (!slot.isConnected) return;
  if (!data.documents.length && !data.kad_os_linked) {
    slot.innerHTML = "";
    return;
  }
  const sheet = await import("../../signDocumentSheet.js");
  const repaint = () => paintCustomerSignDocs(slot, customerId);
  slot.innerHTML = `
    <h3 class="list-group-heading">${t("sd_title")}</h3>
    <div class="card-list">
      ${data.documents.length ? data.documents.slice(0, 6).map((d) => sheet.documentRowHtml(d, { showCustomer: false })).join("") : `<p class="empty-state">${t("sd_empty")}</p>`}
    </div>
    ${data.kad_os_linked && !data.agreement ? `<div class="sd-card-actions"><button type="button" class="btn btn-primary" id="sd-card-agreement">${escapeHtml(t("sd_send_agreement"))}</button></div>` : ""}`;
  slot.querySelectorAll("[data-sign-doc]").forEach((b) => b.addEventListener("click", () => sheet.openSignDocumentSheet(Number(b.dataset.signDoc), { onChanged: repaint })));
  const send = slot.querySelector("#sd-card-agreement");
  send?.addEventListener("click", async () => {
    send.disabled = true;
    const doc = await sheet.openSendAgreementSheet({ customerId, onSent: repaint });
    if (!doc) send.disabled = false;
  });
}
