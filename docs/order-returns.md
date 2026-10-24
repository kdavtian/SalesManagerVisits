# Order returns and cancellations

Added in 1.395.0 (migration 143). Owner's rules (2026-10-24): the rep asks, management approves, the warehouse manager confirms receipt first, the customer shows a provisional credit at once, any order can be returned or cancelled.

## What happens

| Order status when asked | Request kind | What it does |
|---|---|---|
| delivered | **return** (some products or the whole order) | quantities are capped by what is still returnable; credit = unit price actually paid (the order discount is spread over the lines) x quantity |
| submitted / confirmed / packed | **cancel** (whole order, one open request per order) | on approval the order leaves every live queue (same state as a KAD OS cancellation: `draft` + `cancelled_at` + `cancel_reason`). A packed order waits for the warehouse manager to confirm the goods are back on the shelf |
| draft / already cancelled | not possible | |

Flow: `requested` -> (management / accountant) `approved` or `rejected` (a reason is required) -> (warehouse manager) `done` with every returned line marked **good** or **damaged** -> (accountant) **Recorded in Excel**.

Excel records a return as a negative-quantity order line. After each ERP sync `matchReturnsToErp` looks for a negative line of the same customer and product since the request date with at least the returned quantity and sets `recorded_via = 'erp'`; if it cannot match, the accountant taps "Recorded in Excel" (`recorded_via = 'manual'`). Until it is recorded the credit shows on the customer's debt tile ("Return credit: N AMD") so nobody chases money that is owed back.

## Who can do what

| Role | Request | Decide | Receive | Record |
|---|---|---|---|---|
| sales_manager | own orders / own customers' orders | | | |
| admin, ceo, operations_director, sales_director, accountant | any order | yes | | accountant, admin |
| warehouse_manager | | | yes (admin too) | |

Server guards: `canApproveReturns`, `canReceiveReturns`, `canRecordReturns` in `server/src/roles.js`; the real boundary is `server/src/routes/returns.js`.

## Where in the app

* Order sheet: **Return** (delivered) or **Cancel order** button, and the requests already made for that order.
* `#/returns` (Home tile "Returns"; warehouse Home tile with a count): tabs To decide / To receive / To record / All.
* Customer card: the debt tile shows the pending credit.

## Notes

* Stock numbers are Excel-driven; the warehouse good/damaged grade is recorded and relayed, it does not edit `stock_qty`.
* No time limit on returns (owner chose "any order").
* Notifications use type `order_status_changed`.
