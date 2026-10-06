// Product detail card: role-based field redaction, photo gallery (main/back),
// details editing, and the per-user pricelist PDF.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let cookies, product;

function photoForm(kind) {
  const form = new FormData();
  form.append("image", new Blob([PNG], { type: "image/png" }), "p.png");
  form.append("kind", kind);
  return form;
}

test.before(async () => {
  await startTestServer();
  cookies = {};
  for (const role of ["admin", "sales_manager", "ceo"]) cookies[role] = await loginAs((await createUser(role)).email);
  product = await createProduct({ name: "Itest Castrol Edge 5W-40 4L", unit: "4L" });
  await pool.query(
    "UPDATE products SET brand = 'Castrol', bronze_price_amd = 30000, silver_price_amd = 28000, gold_price_amd = 26000, retail_price_amd = 36000, landing_cost_amd = 20000, net_cost_amd = 21000 WHERE id = $1",
    [product.id]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM product_images WHERE product_id = $1", [product.id]);
  await cleanupAll();
  await stopTestServer();
});

test("gold price, landing cost and net cost are only in management's responses", async () => {
  const list = await apiRequest("/api/products", { cookie: cookies.sales_manager });
  const row = list.data.find((p) => p.id === product.id);
  assert.equal(row.silver_price_amd, "28000");
  for (const key of ["gold_price_amd", "landing_cost_amd", "net_cost_amd"]) assert.equal(key in row, false, `${key} leaked`);
  const detailMgr = await apiRequest(`/api/products/${product.id}`, { cookie: cookies.sales_manager });
  assert.equal("landing_cost_amd" in detailMgr.data, false);
  const detailCeo = await apiRequest(`/api/products/${product.id}`, { cookie: cookies.ceo });
  assert.equal(detailCeo.data.landing_cost_amd, "20000");
  assert.equal(detailCeo.data.gold_price_amd, "26000");
});

test("photos: first becomes main, another can be made main, delete promotes the next", async () => {
  const denied = await apiFormRequest(`/api/products/${product.id}/images`, { form: photoForm("front"), cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);
  const first = await apiFormRequest(`/api/products/${product.id}/images`, { form: photoForm("front"), cookie: cookies.admin });
  assert.equal(first.status, 201);
  const second = await apiFormRequest(`/api/products/${product.id}/images`, { form: photoForm("back"), cookie: cookies.admin });
  assert.equal(second.data.images.length, 2);
  assert.equal(second.data.images[0].is_main, true);
  const backId = second.data.images.find((i) => i.kind === "back").id;
  const promoted = await apiRequest(`/api/products/${product.id}/images/${backId}`, { method: "PATCH", cookie: cookies.admin, body: { is_main: true } });
  assert.equal(promoted.data.images.find((i) => i.id === backId).is_main, true);
  assert.equal(promoted.data.images.filter((i) => i.is_main).length, 1);
  const removed = await apiRequest(`/api/products/${product.id}/images/${backId}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(removed.data.images.length, 1);
  assert.equal(removed.data.images[0].is_main, true);
  const { rows } = await pool.query("SELECT image_path FROM products WHERE id = $1", [product.id]);
  assert.ok(rows[0].image_path);
});

test("details: managers edit description/approvals/specs; sales manager cannot; price sync stays unlocked", async () => {
  const body = { description: "Synthetic oil", approvals: ["VW 502 00", "MB 229.5"], specs: [{ label: "SAE", value: "5W-40" }] };
  const denied = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.sales_manager, body });
  assert.equal(denied.status, 403);
  const ok = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.admin, body });
  assert.equal(ok.status, 200);
  const detail = await apiRequest(`/api/products/${product.id}`, { cookie: cookies.sales_manager });
  assert.deepEqual(detail.data.approvals, ["VW 502 00", "MB 229.5"]);
  assert.equal(detail.data.specs[0].label, "SAE");
  const { rows } = await pool.query("SELECT manually_edited_at FROM products WHERE id = $1", [product.id]);
  assert.equal(rows[0].manually_edited_at, null);
  const bad = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.admin, body: { approvals: "nope" } });
  assert.equal(bad.status, 400);
});

test("pricelist PDF: sales manager gets a PDF without gold; validation errors are clear", async () => {
  const res = await apiRequest("/api/products/pricelist.pdf", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { columns: ["silver", "retail"], valid_until: "2026-10-30", brands: ["Castrol"] },
  });
  assert.equal(res.status, 200);
  assert.ok(String(res.data).startsWith("%PDF"));
  const onlyGold = await apiRequest("/api/products/pricelist.pdf", { method: "POST", cookie: cookies.sales_manager, body: { columns: ["gold"], valid_until: "2026-10-30" } });
  assert.equal(onlyGold.status, 400);
  const noDate = await apiRequest("/api/products/pricelist.pdf", { method: "POST", cookie: cookies.ceo, body: { columns: ["gold"] } });
  assert.equal(noDate.status, 400);
  const mgmt = await apiRequest("/api/products/pricelist.pdf", { method: "POST", cookie: cookies.ceo, body: { columns: ["bronze", "silver", "gold", "retail"], valid_until: "2026-10-30" } });
  assert.equal(mgmt.status, 200);
});
