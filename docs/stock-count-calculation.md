# Stock count: how the numbers are made (checked 2026-11-05)

**Counted** = what the warehouse manager types for a product (whole packs).
**In app** (`expected_qty`, `server/src/orders/appStock.js`) = Excel stock (`products.stock_qty`, as of the last sync)
 - packs packed and taken out, not delivered yet (`packed_stock_out`; no time limit)
 - packs of orders delivered in the app that Excel does not hold yet (`delivered`, no "found in Excel" link, last 14 days)
 + good returns the warehouse took back that Excel does not hold yet.
Submitted / confirmed orders are not subtracted (the goods are still on the shelf). Unknown Excel stock stays unknown (no difference is reported).
**Difference** = counted - in app; every difference becomes one task for the accountant, one recheck task for the counter and a notice to the CEO / admin.

Excel stock itself = `OB + purchases - ORDERS.Qty` (Inventory sheet): goods leave Excel stock when the accountant enters the sale, and enter it when the accountant enters the purchase.

## What can make the shelf hold MORE than "in app" (found in the review)
1. Stock was frozen for every hand-edited product: the sync wrote stock only for products nobody had edited in the app. Fixed 1.521.0: stock follows the workbook for every product.
2. An order delivered in the app is subtracted until Excel is matched to it; the match needs the same customer, the same total (+-1 AMD) and a UNIQUE pair. An order Excel shows under another total (a discount entered differently, rounding, a split), or two same-day orders of one customer with the same total, never matches, so it is subtracted AGAIN for up to 14 days. The "!" next to the app's number now lists these pieces (management, today).
3. Goods bought but not yet entered by the accountant (customs lag) are on the shelf and not in Excel.
4. Products the workbook does not send (no price, or SKU Status not ACTIVE and not already in the app) are not in the app at all, so they are never counted. Not changed: needs the owner's decision.

## When the APP holds MORE than the shelf (owner, 2026-11-05: this is the case)
1. Frozen stock (fixed 1.521.0): a hand-edited product kept the quantity of an old sync, higher than today's.
2. Goods left with no sale in Excel yet (the accountant enters sales later; samples, gifts, damaged goods, internal use, monthly write-outs of customer 10000) and no order in the app.
3. A delivery in the app that Excel never got: after 14 days the app stops subtracting it. The "!" popup (1.522.0) lists these as "delivered more than 14 days ago, still not found in Excel" (not subtracted): that number is how much too high the app is because of them. Extending the window would bring back the double subtraction for orders Excel has under another total, so it is the owner's call.
4. A purchase entered in Excel before the goods reached the shelf (customs lag).
