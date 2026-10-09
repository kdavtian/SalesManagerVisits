// Renders a sample of the order blank (full + half versions) with made-up data:
//   node scripts/order-blank-sample.mjs  ->  order-blank-sample.pdf
import fs from "node:fs";
import { buildOrderBlanksPdf } from "../src/orderBlankPdf.js";

const mk = (rows) => rows.map(([brand, product_name, size_l, quantity, unit_price_amd]) => ({ brand, product_name, size_l, quantity, unit_price_amd, line_total_amd: quantity * unit_price_amd }));
const rep = { name: "Արտակ Հայրապետյան", phone: "033007059", officePhone: "091-007-019" };
const big = mk([
  ["Castrol", "EDGE 5W-30 LL", "4", 6, 21500], ["Castrol", "MAGNATEC 10W-40 A3/B4", "4", 4, 16800], ["Castrol", "GTX 15W-40", "5", 3, 17900],
  ["Castrol", "TRANSMAX ATF DEX III", "1", 12, 3700], ["Lotos", "SYNTHETIC 5W-40", "4", 5, 14200], ["Royal", "SUPER ATF6", "1", 12, 3700],
  ["Orlen", "OIL PLATINUM 5W-30", "4", 2, 13900], ["Castrol", "EDGE 0W-20", "4", 2, 24800], ["Castrol", "POWER1 4T 10W-40", "1", 10, 4200],
  ["Lotos", "TURBODIESEL 10W-40", "5", 3, 15600], ["Castrol", "VECTON 15W-40", "20", 1, 68000], ["Royal", "SUPER 5W-40", "4", 4, 12900],
]);
const smallA = mk([["Castrol", "EDGE 5W-30 LL", "4", 4, 21500], ["Castrol", "TRANSMAX ATF DEX III", "1", 6, 3700], ["Royal", "SUPER ATF6", "1", 12, 3700]]);
const smallB = mk([["Lotos", "SYNTHETIC 5W-40", "4", 2, 14200], ["Castrol", "GTX 15W-40", "5", 2, 17900], ["Castrol", "MAGNATEC 5W-30", "4", 3, 17800], ["Castrol", "POWER1 4T 10W-40", "1", 8, 4200]]);
const sum = (items) => items.reduce((s, i) => s + i.line_total_amd, 0);
const order = (code, items) => ({ order_code: code, created_at: new Date("2026-10-08T10:00:00+04:00"), total_amd: sum(items) });

const pdf = await buildOrderBlanksPdf([
  { variant: "half", order: order("26100802", smallA), items: smallA, customer: { name: "10228 «Արտակ Ավտո» ՍՊԸ", erp_customer_id: "10228", tin: "00000000", address: "ք. Երևան, Տիգրան Մեծի 12", legal_name: "«Արտակ Ավտո» Սահմանափակ պատասխանատվությամբ ընկերություն" }, rep, previousDebtAmd: 185000 },
  { variant: "half", order: order("26100803", smallB), items: smallB, customer: { name: "Գևորգ Մկրտչյան ԱՁ", erp_customer_id: "10301", tin: "11111111", address: "ք. Գյումրի, Շիրակացու 5", legal_name: "Գևորգ Մկրտչյան ԱՁ" }, rep, previousDebtAmd: 0 },
  { variant: "full", order: order("26100801", big), items: big, customer: { name: "10228 «Արտակ Ավտո» ՍՊԸ", erp_customer_id: "10228", tin: "00000000", address: "ք. Երևան, Տիգրան Մեծի 12", legal_name: "«Արտակ Ավտո» Սահմանափակ պատասխանատվությամբ ընկերություն" }, rep, previousDebtAmd: 185000 },
]);
fs.writeFileSync("order-blank-sample.pdf", pdf);
console.log("order-blank-sample.pdf", pdf.length, "bytes");
