// The fingerprint of a document for signature (e-signature design, kad-gmm docs/e-signature.md section 2): what is signed can never change, so
// the frozen content is hashed and the hash is printed on the PDF and stored with the signature. KAD OS sends it back with the signature and
// the server refuses one that is not the current version's.
//
// Canonical JSON (so the same content always gives the same hash, in any app): object keys sorted by code point, no spaces, arrays in their
// order, numbers as JSON.stringify writes them, undefined values dropped (as JSON.stringify does). The hashed value is
//   canonicalJson({ content, customer_id, kind, number, version })
// and the fingerprint is its SHA-256 as 64 lowercase hex characters.
import crypto from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonicalJson(v))).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function documentFingerprint({ content, customerId, kind, number, version }) {
  const payload = canonicalJson({ content, customer_id: Number(customerId), kind, number, version: Number(version) });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}
