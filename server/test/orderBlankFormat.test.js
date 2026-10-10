import test from "node:test";
import assert from "node:assert/strict";
import { formatSize, formatPhone, cleanCustomerName, lineLiters, formatLiters } from "../src/orderBlankPdf.js";

test("package size always carries the litre mark", () => {
  assert.equal(formatSize("4"), "4 L");
  assert.equal(formatSize("208L"), "208 L");
  assert.equal(formatSize("0,5 l"), "0.5 L");
  assert.equal(formatSize("pcs"), "pcs");
  assert.equal(formatSize(null), "");
});

test("phones print as +374 XX XXX XXX", () => {
  assert.equal(formatPhone("033007059"), "+374 33 007 059");
  assert.equal(formatPhone("091-007-019"), "+374 91 007 019");
  assert.equal(formatPhone("+(374) 96 007 015"), "+374 96 007 015");
  assert.equal(formatPhone("+37433007059"), "+374 33 007 059");
  assert.equal(formatPhone("12345"), "12345");
});

test("the ERP id is dropped from the printed customer name", () => {
  assert.equal(cleanCustomerName("10324 Getq / Ara"), "Getq / Ara");
  assert.equal(cleanCustomerName("10324 - «Արտակ Ավտո» ՍՊԸ"), "«Արտակ Ավտո» ՍՊԸ");
  assert.equal(cleanCustomerName("Getq / Ara"), "Getq / Ara");
  assert.equal(cleanCustomerName("5 Star Garage"), "5 Star Garage");
});

test("total litres = quantity x package size, non-litre units add nothing", () => {
  assert.equal(lineLiters({ size_l: "4L", quantity: 6 }), 24);
  assert.equal(lineLiters({ size_l: "208", quantity: 1 }), 208);
  assert.equal(lineLiters({ size_l: "0,5", quantity: 4 }), 2);
  assert.equal(lineLiters({ size_l: "pcs", quantity: 9 }), 0);
  assert.equal(formatLiters(34), "34 L");
  assert.equal(formatLiters(12.25), "12.3 L");
  assert.equal(formatLiters(1208), "1,208 L");
});

test("phones are stored as digits only: +37491007019", async () => {
  const { normalizePhoneForStorage } = await import("../src/phoneFormat.js");
  assert.equal(normalizePhoneForStorage("091-007-019"), "+37491007019");
  assert.equal(normalizePhoneForStorage("+374 91 007 019"), "+37491007019");
  assert.equal(normalizePhoneForStorage("+374 91 007019"), "+37491007019");
  assert.equal(normalizePhoneForStorage("91007019"), "+37491007019");
  assert.equal(normalizePhoneForStorage(" "), null);
  assert.equal(normalizePhoneForStorage("+374 "), null);
  assert.equal(normalizePhoneForStorage(null), null);
  assert.equal(normalizePhoneForStorage("+7 495 123 45 67"), "+7 495 123 45 67", "foreign numbers are left alone");
});
