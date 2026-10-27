// The sentence the customer reads on the signature page before signing (owner, 2026-10-27): "I received order X [and paid Y]. My debt
// is Z." The server fills it in (GET /customers/:id/sign-statement, the same debt the signed blank prints). The texts (edited in
// Settings > Sales & customers) are kept on the phone, so offline the sentence is still shown, without the debt the phone cannot know.
import { api } from "./api.js";

const TEXTS_KEY = "fv_sign_texts";

function savedTexts() {
  try {
    return JSON.parse(localStorage.getItem(TEXTS_KEY) || "null");
  } catch {
    return null;
  }
}

// Same rules as server/src/documentTexts.js signStatement. Also used live by the driver's delivery sheet.
export function composeStatement(texts, { orderCodes, paymentAmd, balanceAfterAmd }) {
  const amd = (n) => Math.round(Number(n)).toLocaleString("en-US");
  const hasOrders = orderCodes.length > 0;
  const hasPayment = Number(paymentAmd) > 0;
  let text = hasOrders && hasPayment ? texts.sign_order_payment : hasOrders ? texts.sign_order : hasPayment ? texts.sign_payment : "";
  if (balanceAfterAmd == null) text = text.split(/(?<=[։:.])\s+/).filter((s) => !s.includes("[updated debt balance]")).join(" ");
  return text
    .replaceAll("[order no]", orderCodes.join(", "))
    .replaceAll("[payment amount]", hasPayment ? amd(paymentAmd) : "")
    .replaceAll("[updated debt balance]", balanceAfterAmd == null ? "" : amd(balanceAfterAmd))
    .trim();
}

/** { orderIds, orderCodes, paymentAmd } -> the sentence ("" when there is nothing to confirm or no texts yet). Never throws. */
export async function customerSignStatement(customerId, { orderIds = [], orderCodes = [], paymentAmd = 0 } = {}) {
  if (!orderIds.length && !(Number(paymentAmd) > 0)) return "";
  try {
    const res = await api.signStatement(customerId, { orderIds, paymentAmd });
    try {
      localStorage.setItem(TEXTS_KEY, JSON.stringify(res.texts));
    } catch {
      /* private mode: the next offline signature shows no sentence */
    }
    return res.statement;
  } catch {
    const texts = savedTexts();
    return texts ? composeStatement(texts, { orderCodes, paymentAmd, balanceAfterAmd: null }) : "";
  }
}
