// Competitor brand names in Armenian for server texts (notifications, Vaghinak's tasks): the app's own translation when it has one, else
// the name the brand was added with, else its key.
import { hyCommon } from "../../../../client/public/js/i18n/hy/common.js";

export function competitorNameHy(key, names = new Map()) {
  return hyCommon[`competitor_${key}`] ?? names.get(key) ?? key;
}
