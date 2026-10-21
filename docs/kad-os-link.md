# KAD OS <-> KAD Motors link (built 2026-10-21, app 1.377.0)

KAD Motors (this app) is the **supplier**. Its wholesale customers (e.g. 10001 Garage Masters Mall / GTAR GROUP) run **KAD OS** (the
KAD-GMM app) as their free ERP and order from us inside it. This file is the supplier-side reference; the customer side is in the
KAD-GMM repo (`docs/kad-orders.md`).

## What the customer gets, what the supplier sees
| Topic | Rule |
|---|---|
| Order | The customer builds a basket in KAD OS; it arrives here as a normal order (status *submitted*) with the **APP** badge and goes through the usual credit-limit / discount / price-floor checks. |
| Statuses the customer sees | **received** (submitted) -> **confirmed** -> **packed** -> **on the way** (packed AND on a delivery route) -> **delivered**. A draft that was sent back for correction shows as **on hold**. Each step carries its time. |
| Debt and payments | `GET /api/partner/balance`: debt (Excel), overdue part (FIFO aging, same as Debt balances), credit limit and what is left, orders not yet in Excel, the last payments (Excel cashflow). Both sides see the same numbers. |
| App discount | Flat % (default **2**) on every line that has no campaign price, stored as an ordinary flat-AMD order discount (`discount_amd`) plus `orders.app_discount_pct`. Up to 3 % is auto-approved by the existing discount policy; a higher setting needs a director on each order. |
| Campaigns / bundles | Supplier-created, limited-time, for **all** or **selected** customers, **app orders only**. *discount*: each listed product ordered at >= its min qty gets the %. *bundle*: the % applies only when EVERY listed product is in the order at >= its min qty. A campaign price **replaces** the app discount on that line (never stacks). Created by admin / CEO / sales director, live at once; saving is refused (409 `below_cost`) when any covered tier would sell under net cost or landing cost. Paused / ended / deleted (only while unused) from Settings -> KAD OS -> Campaigns. |
| Who looks after the customer | The customer's own sales manager sees its app orders in Orders and on the customer card (read only: only the order's owner or an admin edits) and gets a notification "Customer ordered through KAD OS" with items, amount and the promise date. Other reps do not see them. |
| Chasing | Vaghinak chases an app order sooner than an ordinary one: after `chase_confirm_hours` (default 2) without confirmation (pack / deliver: half the usual limit); twice as long also tells the CEO/admins. The message says how many of the late orders came from KAD OS. Switch off or change in Settings -> KAD OS. |
| What the customer is told about a hold | `attention`: `approval` (price or credit limit still to be approved) or `returned` (sent back for a correction). The reason is never passed on. |
| Priority | App orders are listed first in Orders (waiting statuses), Warehouse staging and Delivery packed orders, and carry the APP badge. |
| Delivery promise | `orders.promised_date` = N working days after the order (Sunday and company holidays do not count; ordered after the cut-off hour counts from the next working day). A promise only: nothing enforced, nobody alerted. |
| Progress | Per Yerevan month: number of app orders -> level 1-4 (thresholds editable), % to the next level, weekly streak, "saved this month" (app discount + campaign savings), app share of all orders (90 days). |

## Settings (Settings -> Admin workspace -> KAD OS)
Stored in `app_settings.app_orders` (JSON); every key has an On/Off and a number: `discount_enabled`/`discount_pct`,
`priority_enabled`, `promise_enabled`/`promise_working_days`/`promise_cutoff_hour`, `progress_enabled`/`levels` (four ascending order
counts), `chase_enabled`/`chase_confirm_hours`. Defaults = owner's choice of 2026-10-21 (flat 2 %, priority on, promise 2 working days before 15:00, progress on). Changes are
logged in `app_orders_log`. Admin/CEO only; campaigns also the sales director.

## How a customer's KAD OS is connected
1. Create a KAD user for the install (any non-admin role, e.g. *sales_manager*, no customers assigned), e.g. "KAD OS - Garage Masters Mall".
2. Settings -> KAD OS -> Customer accounts -> **+ Link an account**: pick that user and the customer (must have its ERP ID).
   This writes `partner_links (user_id, customer_id)`.
3. In KAD OS put that user's e-mail/password in the server `.env` (`KAD_API_URL`, `KAD_EMAIL`, `KAD_PASSWORD`), as before.
From then on **every order by that account is an app order for that customer**, whichever URL it uses (`POST /api/orders` or
`POST /api/partner/orders`): the customer id and any discount in the request are ignored, prices come from the customer's tier.
**A linked account can do nothing else in KAD**: every other API route answers 403 `partner_only` (the login lives on the customer's server, so a leak must not expose the price lists, customers or debts). An account without a link behaves exactly as before. Linking admin / CEO accounts is refused. The linked customer cannot be deleted
while linked (FK RESTRICT).

## API for the customer's KAD OS (`/api/partner/*`, session cookie like the app; 403 `not_partner` when the account is not linked)
`GET /me` (customer, its payment terms (`terms`, from the customer record), perks, balance summary, progress, running offers, next promise date) · `GET /catalog` (tier price + availability,
never costs) · `GET /offers` · `GET /orders`, `GET /orders/:id` (5-step status + timeline, lines with list price / campaign) ·
`GET /balance` · `POST /preview` (price a basket: campaigns, app discount, promise date, nothing saved) · `POST /orders`.
Only the linked customer's data is reachable.

## Supplier-side API (`/api/app-orders/*`)
`GET|PUT /settings` and `POST|DELETE /links` (admin/CEO) · `GET|POST /campaigns`, `PATCH /campaigns/:id` (`paused`, `end_now`),
`DELETE /campaigns/:id` (only while unused) (admin/CEO/sales director).

## Data
Migration 136: `partner_links`, `campaigns`, `campaign_products`, `campaign_customers`, `orders.placed_via_app/app_discount_pct/promised_date`,
`order_items.campaign_id/list_price_amd`, `app_settings.app_orders`, `app_orders_log`. Existing `product_promos` (date-ranged display
prices on the price list) is a different, older feature and is not touched.

## Not built yet (ideas, owner to decide)
Push/Telegram to the customer when a campaign starts or an order changes status (KAD OS polls today); auto-confirm of safe app orders;
Vaghinak chasing app orders that wait too long; per-customer targeting by past purchases ("customers who bought X"); a supplier report
"liters via app vs by phone".
