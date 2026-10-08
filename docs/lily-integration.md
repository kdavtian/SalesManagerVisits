# KAD <-> Lily integration (as built)

Implements `KAD-Lily-API-spec.md`. Lily is the AI accountant: management confirms
an order in KAD and asks accounting for its document; Lily pulls those requests,
claims them, creates the waybill(s) in ՀԾ-Հաշվապահ, exports to SRC e-invoicing and
reports back. She never signs and never edits orders.

## What maps to `pending`

An order is `pending` when **management confirmed it in KAD** (order status
`confirmed` or later) **and then sent it to accounting** from the confirm sheet
(or later from the order sheet). Cash order -> waybill (Բեռնագիր); invoice order ->
Հաշիվ ապրանքագիր (`doc_type: "invoice"`, same endpoints). This is a hard rule (also enforced by the
database): `doc_type` is `waybill` only when `payment_method` is `cash`, and `invoice` only when it is `invoice`. Management can change the
payment method on that sheet while the request is `pending`.

Statuses: `pending -> in_progress -> waybill_created | partially_created -> exported_unsigned -> signed`,
`needs_attention` and `cancelled` (a request withdrawn in KAD; Lily never sees it as ready). Management and the
accountant can also move a request to any status by hand from the order sheet (`pending` puts it back in the queue). `needs_attention -> pending` when management taps "Send to
accounting again" in the app. A claim that is not reported on within **30 minutes**
goes back to `pending`.

## API

Base URL: `https://<kad-host>/api/integration/v1`. HTTPS, JSON UTF-8, `Authorization: Bearer <token>`.
Writes accept `Idempotency-Key` (same key + same request replays the first response, header
`Idempotent-Replay: true`). Errors: `{ "error": { "code", "message" } }`. Timestamps are
ISO 8601 with `+04:00`. Every call with a token is stored in `integration_audit_log`.

| Method | Path | Spec |
|---|---|---|
| GET | `/orders?waybill_status=pending&limit=50` | 3.1 (also `doc_type=waybill\|invoice`) |
| GET | `/orders/{id}` | 3.2, includes `waybills` and `issue` |
| POST | `/orders/{id}/claim` | 3.3 body `{agent, claimed_at}` (optional); 409 `not_pending` |
| POST | `/orders/{id}/waybills` | 3.4 |
| POST | `/orders/{id}/waybills/{hc_doc_number}/einvoicing` | 3.5 |
| GET | `/products?updated_since=YYYY-MM-DD` | 3.6 (also `unmapped=1`) |
| POST | `/orders/{id}/issue` | 3.7 (`/problem` is an alias) |
| GET | `/ping` | token check `{ ok, token, test_mode }` |
| GET | `/wait?timeout=25` | long-poll: returns `{ pending, orders }` at once if requests are waiting, else holds up to 25 s and returns the moment KAD queues one |
| POST | `/orders/{id}/documents?filename=&hc_doc_number=` | signed copy: raw PDF body, `Content-Type: application/pdf` (<= 15 MB); same `hc_doc_number` replaces the file |

### Order object (`GET /orders`, example, personal data removed)

```json
{
  "orders": [
    {
      "id": "ord_000123",
      "number": "26100505",
      "created_at": "2026-10-05T17:05:00+04:00",
      "ship_date": null,
      "customer": { "name": "Customer LLC", "tax_id": "01234567", "erp_customer_id": "10001" },
      "destination_warehouse": null,
      "note": null,
      "waybill_status": "pending",
      "doc_type": "waybill",
      "payment_method": "cash",
      "kad_order_status": "confirmed",
      "is_test": false,
      "discount_pct": 0, "discount_amd": 0, "total_amd": 30000,
      "waybills": [], "issue": null,
      "items": [
        { "line_id": "ln_45", "hc_code": "000010", "kad_sku": "CASTROL-EDGE-C5-0W20-4L",
          "name": "CASTROL EDGE C5 0W-20 4L", "brand": "Castrol", "quantity": 2, "unit": "pcs",
          "unit_price_amd": 15000, "line_total_amd": 30000 }
      ]
    }
  ]
}
```

- `ship_date` and `destination_warehouse` are **always `null`**: KAD does not hold them, so
  Lily's defaults apply (today / warehouse 04).
- `hc_code` is `null` for a product that has not been mapped yet. Lily may match the product in HC
  by brand / name / size and use that code in the waybill `items[].hc_code`; she reports it back
  there (and may ask management to confirm). If she cannot find a match she reports `unknown_product`
  via `/issue`.
- `total_amd` already includes the order-level discount in `discount_*`; line prices are before it.

### 3.4 Report waybills

Body exactly as in the spec (`hc_doc_number`, `hc_isn`, `date`, `warehouse_from`,
`warehouse_to`, `brand`, `items[{line_id, hc_code, quantity}]`, `created_at`). Allowed while the
order is `in_progress`, `partially_created` or `waybill_created`. Quantities per `line_id` are
summed over all reported waybills: when every ordered line is covered the order becomes
`waybill_created`, otherwise `partially_created`. An unknown `line_id` is a 400. Re-sending an
`hc_doc_number` replaces that waybill. The numbers are shown on the order in the app.

### 3.5 E-invoicing

`{ "exported_at": "...", "status": "exported_unsigned" | "signed" }` per waybill. The order becomes
`exported_unsigned` when every waybill has been exported, `signed` when all are signed (it stays
`partially_created` while lines are still uncovered). A human can also mark waybills signed in
KAD ("Mark as signed" on the order sheet).

### 3.7 Issue

`code` must be one of `insufficient_stock`, `unknown_product`, `hc_unavailable`,
`mixed_destination`, `other`; `message` required; `lines` optional. Sets `needs_attention`,
releases the claim, and the message is shown on the order.

## Product mapping (`hc_code`)

`hc_code` is stored on each KAD product, so every order line already carries it. It is filled
automatically by the ERP sync from the **HC_ID** column of the workbook's **Products** sheet
(matched on ProductID, kept as text with leading zeros; a blank cell never wipes a code already
in KAD, and a value in the sheet overrides the one in KAD). It can also be set by hand: management sets it
with `PATCH /api/products/:id {"hc_code":"000010"}` or in bulk with
`POST /api/products/hc-codes {"mappings":[{"sku":"...","hc_code":"..."}]}` (unknown SKUs are
returned, not created). Seed it from Lily's list of ~120 HC codes.

## Tokens (admin) and revoking

- On the server: `node scripts/integration-token.mjs create "Lily"` (add `--test` for a test token),
  `list`, `revoke <id>`. With Docker: `docker compose exec app node scripts/integration-token.mjs create "Lily"`.
  The plaintext is printed once; set it yourself on the accounting PC as `KAD_API_TOKEN`
  (with `KAD_API_URL`), never in chat.
- As admin over the app API: `POST /api/integration-tokens {name, test_mode}`,
  `GET /api/integration-tokens`, `DELETE /api/integration-tokens/:id` (revoke),
  `GET /api/integration-tokens/audit`.
- Only a SHA-256 of the token is stored. A token can read orders/products and write accounting
  status only; it cannot edit items, prices, customers or anything else.

## Test mode

Use a test token (`--test`). It only sees orders flagged as test and a normal token never sees them.
An admin flags an order as a test order when sending it to accounting:
`POST /api/orders/:id/accounting-request {"payment_method":"cash","test":true}`.
Test orders never touch real orders; the whole flow (claim, waybills, e-invoicing, issue) can be
exercised with them.

## In the app

- After confirming an order (director, CEO, operations director, admin) a sheet suggests the right
  document for the payment method and lets management change the method.
- Order sheet: accounting status, waybill numbers (with e-invoicing state), issue messages;
  buttons Send / Change document / Send again / Mark as signed.
- Orders list: accounting status badge and an "Accounting" filter in the filter menu.


## Instant command channel (long-poll) and signed documents

Lily runs as a page on the accountant's computer, so KAD cannot call her. Instead she keeps one
call open: **`GET /wait?timeout=25`** in a loop. KAD answers the moment an order enters the queue
(management sends it, or sets it back to `pending`), so she can claim and start at once; if nothing
happens it returns `{ "pending": 0, "orders": [] }` after 25 s and she calls again. The same calls
tell KAD she is online: the Accounting tab shows "Lily is online/offline" (seen within 60 s).

She replies with the existing status calls (claim, waybills, einvoicing, issue). Each of the
useful ones also sends the requester a notification (type `accounting_update`).

**Signed copy.** `POST /orders/{id}/documents?filename=signed-255.pdf&hc_doc_number=255` with the PDF as
the raw body (`Content-Type: application/pdf`). Only real PDFs (`%PDF-` header) are accepted. Stored in
Postgres (`order_documents`), shown on the order sheet, on the customer card (everyone who can open
the customer sees it) and counted on the Accounting tab. Re-sending the same `hc_doc_number` replaces
the file. Admin/management/accountant can delete a stored file in KAD.

## Accounting page in KAD

Home > quick action **Accounting** (everyone; the admin tile editor can hide it per role). Tabs: Requests |
Waybills | Invoices, with All | Unsigned | Signed for created documents, plus search. A rep only sees their
own orders there (the order list is already limited server-side); warehouse, accountant, directors, CEO and
admin see all. Badge on the tile: accounting roles = requests Lily has not finished (pending / in progress /
needs attention); warehouse manager = confirmed orders whose document is already made; others none
(`server/src/accountingBadge.js`). The Orders page no longer has an Accounting chip.
