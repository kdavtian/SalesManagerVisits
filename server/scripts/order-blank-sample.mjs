import fs from "node:fs";
import { buildOrderBlankPdf } from "../src/orderBlankPdf.js";
const items = [
  ["Castrol", "EDGE 5W-30 LL", "4", 6, 21500], ["Castrol", "MAGNATEC 10W-40 A3/B4", "4", 4, 16800],
  ["Castrol", "GTX 15W-40", "5", 3, 17900], ["Castrol", "TRANSMAX ATF DEX III", "1", 12, 3700],
  ["Lotos", "SYNTHETIC 5W-40", "4", 5, 14200], ["Royal", "SUPER ATF6", "1", 12, 3700],
  ["Orlen", "OIL PLATINUM 5W-30", "4", 2, 13900], ["Aral", "SUPER TRONIC 0W-20", "4", 2, 24800],
].map(([brand, product_name, size_l, quantity, unit_price_amd]) => ({ brand, product_name, size_l, quantity, unit_price_amd, line_total_amd: quantity * unit_price_amd }));
const total = items.reduce((s, i) => s + i.line_total_amd, 0);
const pdf = await buildOrderBlankPdf({
  order: { order_code: "26100801", created_at: new Date("2026-10-08T10:00:00+04:00"), total_amd: total },
  items, customer: { name: "«Արտակ Ավտո» ՍՊԸ", erp_customer_id: "10228" },
  rep: { name: "Միկա Գասպարյան", phones: ["+(374) 96 007 015", "+(374) 91 007 019"] },
  previousDebtAmd: 185000, paymentAmd: null,
});
fs.writeFileSync("order-blank-sample.pdf", pdf);
console.log("ok", pdf.length);
