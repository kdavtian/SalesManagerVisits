// The fingerprint of a document for signature (orders/documentFingerprint.js): the same content gives the same hash whatever the key order
// (Postgres JSONB reorders keys), any change of a number, the version, the kind, the number or the customer gives another one.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJson, documentFingerprint } from "../src/orders/documentFingerprint.js";

test("canonical JSON: keys sorted at every level, no spaces, arrays kept in order, undefined dropped", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null, c: [undefined] }), '{"b":null,"c":[null]}');
  assert.equal(canonicalJson("Հաշվապահ"), '"Հաշվապահ"');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
  assert.equal(canonicalJson(Number.NaN), "null");
});

const content = {
  summary: [{ label: "Պատվեր", value: "#12" }],
  lines: [{ key: "1", name: "Magnatec 4L", qty: 4, unit: "հատ", price_amd: 15700, amount_amd: 62800, note: "" }],
  totals: [{ label: "Ընդամենը", amount_amd: 62800 }],
  text: "Ստացել եմ",
  lines_disputable: true,
};
const base = { content, customerId: 7, kind: "delivery", number: "ACT-2026-000001", version: 1 };

test("the fingerprint is SHA-256 hex of the canonical { content, customer_id, kind, number, version }", () => {
  const fp = documentFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  const expected = crypto.createHash("sha256").update(canonicalJson({ content, customer_id: 7, kind: "delivery", number: "ACT-2026-000001", version: 1 })).digest("hex");
  assert.equal(fp, expected);
});

test("key order does not matter; every signed fact does", () => {
  const fp = documentFingerprint(base);
  const reordered = { lines_disputable: true, text: "Ստացել եմ", totals: content.totals, lines: [{ ...content.lines[0] }].map((l) => Object.fromEntries(Object.entries(l).reverse())), summary: content.summary };
  assert.equal(documentFingerprint({ ...base, content: reordered }), fp);
  assert.equal(documentFingerprint({ ...base, customerId: "7", version: "1" }), fp, "ids as text hash the same");
  const changed = [
    { ...base, version: 2 },
    { ...base, kind: "return" },
    { ...base, number: "ACT-2026-000002" },
    { ...base, customerId: 8 },
    { ...base, content: { ...content, lines: [{ ...content.lines[0], qty: 5 }] } },
    { ...base, content: { ...content, text: "Ստացել եմ." } },
  ];
  for (const c of changed) assert.notEqual(documentFingerprint(c), fp);
});
