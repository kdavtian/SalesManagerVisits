// Who paid a bank line (payments redesign, release 2): the accountant's earlier answers, then the TIN, then an exact customer name.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPayerIndex, identifyPayer, nameKey, normText, payerKey, findTins } from "../src/money/payments2/payerMatch.js";

const customers = [
  { id: 1, tin: "01234567", name: "Ավտո Մաս", legal_name: "«Ավտո Մաս» ՍՊԸ" },
  { id: 2, tin: "07654321", name: "Auto Mas Gyumri", legal_name: null },
  { id: 3, tin: "11112222", name: "Oil Shop", legal_name: null },
  { id: 4, tin: "11112222", name: "Oil Shop 2", legal_name: null }, // two branches with one TIN
  { id: 5, tin: null, name: "Garage", legal_name: null },
  { id: 6, tin: null, name: "Garage", legal_name: null }, // two customers with the same name
  { id: 7, tin: null, name: "AB", legal_name: null }, // too short to be a name match
];
const rules = [
  { payer_key: payerKey("Petrosyan Armen"), customer_id: 3 },
  { payer_key: payerKey("ACBA POS settlement"), customer_id: null },
];
const index = buildPayerIndex(customers, rules);

test("names are normalised: case, quotes, punctuation, legal forms", () => {
  assert.equal(normText("ՍՊԸ «Ավտո Մաս»"), "սպը ավտո մաս");
  assert.equal(nameKey("«Ավտո Մաս» ՍՊԸ"), "ավտո մաս");
  assert.equal(nameKey("Auto-Mas LLC"), "auto mas");
  assert.equal(nameKey("Արմեն Ա/Ձ"), "արմեն");
  assert.deepEqual(findTins("ՀՎՀՀ 01234567, acc 2470012345678901"), ["01234567"]);
});

test("a payer confirmed before wins, and 'not a customer' is remembered too", () => {
  assert.deepEqual(identifyPayer({ counterparty: "PETROSYAN  ARMEN", description: "TIN 01234567" }, index), { customerId: 3, how: "learned" });
  assert.deepEqual(identifyPayer({ counterparty: "ACBA POS Settlement" }, index), { notCustomer: true, how: "learned" });
});

test("the TIN in the line finds the customer; a TIN shared by two customers is a choice for the accountant", () => {
  assert.deepEqual(identifyPayer({ counterparty: "Unknown", description: "Payment for oil, ՀՎՀՀ 01234567" }, index), { customerId: 1, how: "tin" });
  assert.deepEqual(identifyPayer({ counterparty: "X", description: "tin 11112222" }, index), { customerId: null, reason: "ambiguous", suggestion: 3 });
});

test("an exact name (without the legal form) finds one customer; two customers with the name, or a short name, do not", () => {
  assert.deepEqual(identifyPayer({ counterparty: "ԱՎՏՈ ՄԱՍ ՍՊԸ" }, index), { customerId: 1, how: "name" });
  assert.deepEqual(identifyPayer({ counterparty: "Garage" }, index), { customerId: null, reason: "ambiguous", suggestion: 5 });
  assert.deepEqual(identifyPayer({ counterparty: "AB" }, index), { customerId: null, reason: "unknown_payer" });
  assert.deepEqual(identifyPayer({ counterparty: "Auto Mas" }, index), { customerId: null, reason: "unknown_payer" }, "a part of a name is not a match");
  assert.deepEqual(identifyPayer({ counterparty: null, description: "cash deposit" }, index), { customerId: null, reason: "unknown_payer" });
});
