import test from "node:test";
import assert from "node:assert/strict";
import { nextNameNumber } from "../src/customers/customerNameSuggest.js";

test("the first customer of a type in a subregion gets number 1", () => {
  assert.equal(nextNameNumber("Ajapnyak / Yuxman ket", []), 1);
  assert.equal(nextNameNumber("Ajapnyak / Yuxman ket", ["Ajapnyak / Autoservice1", "Arabkir / Yuxman ket1"]), 1);
});

test("the next number follows the highest used one; an unnumbered legacy name counts as 1", () => {
  assert.equal(nextNameNumber("Ajapnyak / Yuxman ket", ["Ajapnyak / Yuxman ket1", "Ajapnyak / Yuxman ket2"]), 3);
  assert.equal(nextNameNumber("Ajapnyak / Yuxman ket", ["Ajapnyak / Yuxman ket"]), 2);
  assert.equal(nextNameNumber("Ajapnyak / Yuxman ket", ["ajapnyak / yuxman ket7", "Ajapnyak / Yuxman ket 3"]), 8);
});

test("only exact 'base + number' names count (not longer names or other words)", () => {
  assert.equal(nextNameNumber("Ajapnyak / Other", ["Ajapnyak / Other shop 5", "Ajapnyak / Others9", "Ajapnyak / Other4"]), 5);
  assert.equal(nextNameNumber("A.b (x)", ["A.b (x)2", "AxbX x2"]), 3);
});
