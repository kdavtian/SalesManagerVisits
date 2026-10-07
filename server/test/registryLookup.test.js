import test from "node:test";
import assert from "node:assert/strict";
import { isValidTin, extractByLabels, parseCompanyText } from "../src/registryLookup.js";

test("isValidTin: exactly 8 digits", () => {
  assert.equal(isValidTin("02256083"), true);
  assert.equal(isValidTin("2256083"), false);
  assert.equal(isValidTin("0225608a"), false);
});

test("parseCompanyText reads label: value and label-then-value layouts", () => {
  const html = `<table><tr><th>Կազմակերպության անվանում</th><td>«ՕՐԻՆԱԿ» ՍՊԸ</td></tr>
    <tr><th>Իրավաբանական հասցե</th><td>ք. Երևան, Արարատյան 1</td></tr></table>`;
  assert.deepEqual(parseCompanyText(html), { legal_name: "«ՕՐԻՆԱԿ» ՍՊԸ", legal_address: "ք. Երևան, Արարատյան 1" });
  assert.equal(extractByLabels("Անվանում: Test LLC", ["Անվանում"]), "Test LLC");
  assert.deepEqual(parseCompanyText("<p>nothing here</p>"), { legal_name: null, legal_address: null });
});
