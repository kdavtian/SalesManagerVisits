# KAD <-> Lily integration (as built)

Lily is the AI accountant. Management confirms an order in KAD, then asks
accounting for its document; Lily pulls those requests, creates the document
in ՀԾ-Հաշվապահ, exports it to SRC e-invoicing and reports back.

## Flow in the app

1. A sales director / CEO / operations director / admin confirms an order.
2. A sheet offers the document for the order's payment method:
   **cash -> Բեռնագիր (waybill)**, **invoice -> Հաշիվ ապրանքագիր (invoice)**.
   On the same sheet management can switch the payment method; that decides
   the document. "Not now" skips it; the order sheet keeps a
   "Send to accounting" / "Change document" button.
3. The request sets the order's accounting status to `pending`.
   - An invoice needs the customer's TIN; every request needs an ERP customer id.
   - The method can be changed while `pending`; after Lily claims it, it is hers.
   - `needs_attention` can be re-sent ("Send to accounting again").
4. The order sheet shows the accounting status, the created document
   numbers and any error Lily reported.

Statuses: `pending -> in_progress -> document_created -> exported_unsigned -> signed`,
or `needs_attention` (with `error.code` / `error.message`).
"Ready for a document" = management sent the request, i.e. `waybill_status=pending`.

## API

Base URL: `https://<kad-host>/api/integration/v1`. HTTPS only, JSON UTF-8.
Auth: `Authorization: Bearer <token>`. Writes accept `Idempotency-Key`
(same key + same request replays the first response, header `Idempotent-Replay: true`).
Errors: `{ "error": { "code": "...", "message": "..." } }`. Every call with a
token is written to `integration_audit_log`.

Order ids look like `ord_000123`; line ids like `ln_45`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/ping` | token check: `{ ok, token, test_mode }` |
| GET | `/orders?waybill_status=pending&doc_type=waybill&limit=50` | orders to process (`doc_type` optional: `waybill` or `invoice`) |
| GET | `/orders/:id` | one order, any status |
| POST | `/orders/:id/claim` | `pending -> in_progress`; 409 `not_pending` if already claimed |
| POST | `/orders/:id/documents` (alias `/waybills`) | report created document(s) -> `document_created` |
| POST | `/orders/:id/export` | SRC export result -> `exported_unsigned` / `signed` |
| POST | `/orders/:id/problem` | error (e.g. no stock) -> `needs_attention` |
| GET | `/product-mapping?unmapped=1` | KAD product <-> `hc_code` |

### Order object

```json
{
  "id": "ord_000123",
  "number": "26100505",
  "created_at": "2026-10-05T17:05:00.000Z",
  "ship_date": null,
  "destination_warehouse": null,
  "customer": { "name": "Customer LLC", "erp_customer_id": "10001", "tax_id": "01234567" },
  "note": null,
  "doc_type": "waybill",
  "payment_method": "cash",
  "waybill_status": "pending",
  "kad_order_status": "confirmed",
  "is_test": false,
  "discount_pct": 0, "discount_amd": 0, "total_amd": 30000,
  "documents": [], "error": null,
  "items": [
    { "line_id": "ln_1", "hc_code": "000010", "kad_sku": "CASTROL-EDGE-C5-0W20-4L",
      "name": "Castrol EDGE 0W-20 C5", "brand": "Castrol", "quantity": 2, "unit": "pcs",
      "unit_price_amd": 15000, "line_total_amd": 30000 }
  ]
}
```

`ship_date` and `destination_warehouse` are `null` -- KAD does not hold them;
Lily applies her defaults (today / warehouse 04). `hc_code` is `null` until
management maps the product (see below); Lily should report `product_unmapped`
via `/problem` for such lines. `total_amd` already includes the order-level
discount shown in `discount_*`; line prices are before it.

### Report documents

`POST /orders/:id/documents` (order must be `in_progress` or `document_created`)

```json
{ "documents": [ {
  "number": "WB-1", "hc_id": "HC-77", "date": "2026-10-06", "brand": "Castrol",
  "source_warehouse": "03", "destination_warehouse": "04",
  "lines": [ { "line_id": "ln_1", "quantity": 2 } ] } ] }
```
One waybill per brand: send several entries for a multi-brand order. Re-sending a
number replaces that entry.

### Export result

`POST /orders/:id/export` `{ "number": "WB-1", "status": "exported_unsigned" | "signed" }`
(omit `number` to apply to every document). The order becomes `exported_unsigned`
when every document is exported and `signed` when every document is signed.

### Problem

`POST /orders/:id/problem` `{ "code": "insufficient_stock", "message": "...", "details": {...} }`.
Management sees the message on the order and can send it again.

## Tokens (admin)

- CLI on the server: `node scripts/integration-token.mjs create "Lily"` (add `--test`
  for a test token), `list`, `revoke <id>`. With Docker:
  `docker compose exec app node scripts/integration-token.mjs create "Lily"`.
- Or as admin over the app API: `POST /api/integration-tokens {name, test_mode}`
  (plaintext returned once), `GET /api/integration-tokens`, `DELETE /api/integration-tokens/:id`
  (revoke), `GET /api/integration-tokens/audit`.
- Only a SHA-256 of the token is stored. Tokens can read orders / product mapping
  and write accounting status only; they cannot change items, prices or customers.
- Store it on Lily's PC as `KAD_API_TOKEN` (and `KAD_API_URL`); never paste it in chat.

## Test mode

A test token only sees orders flagged `is_test` and a normal token never sees them.
An admin flags an order by sending it with `{"test": true}`:
`POST /api/orders/:id/accounting-request {"payment_method":"cash","test":true}`.

## Product mapping (KAD <-> HC)

`products.hc_code`. Management sets it with `PATCH /api/products/:id {"hc_code":"000010"}`
or in bulk `POST /api/products/hc-codes {"mappings":[{"sku":"...","hc_code":"..."}]}`
(unknown skus are returned, not created). Lily reads it from the order lines or
`GET /product-mapping`.
