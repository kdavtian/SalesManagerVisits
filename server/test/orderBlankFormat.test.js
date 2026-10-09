import test from "node:test";
import assert from "node:assert/strict";
import { formatSize, formatPhone, cleanCustomerName } from "../src/orderBlankPdf.js";

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
