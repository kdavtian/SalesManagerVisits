# Roles and permissions

Seven roles, defined in `server/src/roles.js`. Access control is
**entirely application-code enforcement** — every capability below is a
function checked in a route handler, not a database-level policy. See
[`governance/service-objectives-and-security.md`](governance/service-objectives-and-security.md)
for what that implies.

| Role | Who |
|---|---|
| `admin` | Technical/system administrator. Treated as a CEO-equivalent superset throughout — can always unblock a stuck workflow. |
| `ceo` | Full company-wide visibility and final approval authority on performance plans and cash custody. |
| `sales_director` | Manages a team of sales managers; reviews orders, reassigns customers, plans routes for others. |
| `sales_manager` | Field rep. The only role scoped to "own data only" by default. |
| `warehouse_manager` | Packs orders, manages stock/staging. |
| `delivery_manager` | Plans and drives delivery routes, confirms deliveries. |
| `accountant` | Reviews/approves payments, manages product pricing, reconciles against ERP data. |

## Data visibility

| Who sees what | Function | Behavior |
|---|---|---|
| Activity, customers, most lists | `seesAllActivity` | Every role except `sales_manager` sees everyone's data; `sales_manager` sees only their own. |
| Financial CSV exports (payments, debt, orders) | `seesFinancialExports` | `admin`, `ceo`, `sales_director`, `accountant`. |
| Live team-location map | `canViewTeamLocations` | `admin`, `sales_director`, `ceo`. |
| A customer's ERP data (debt, order/payment history) | `seesCustomerErpData` | `sales_manager` only for customers assigned to them; every other role sees it for any customer. |
| Payments | `seesAllPayments` (= `seesAllActivity`) | Same shape as Activity. |
| Unrecorded-order backlog badge | `seesUnrecordedBadge` | `accountant`, `ceo`, `admin` — deliberately not `sales_director`. |
| Generated reports (Sales Director/debt/CEO workbooks) | `seesGeneratedReports` (= `seesFinancialExports`) | Same as financial exports. |
| Team Performance (company-wide vs. own channel) | `seesAllPerformance` | `admin`, `ceo`, `sales_director`, `accountant`. |
| Location broadcast (foreground GPS while app is open) | `broadcastsLocation` | Every field-facing role except `admin`/`ceo` (they don't visit customers). |

## Customers

| Action | Function | Behavior |
|---|---|---|
| Direct edit/delete (bypassing the edit-request approval flow) | `canDeleteOrEditDirectly` | `admin` only. |
| Reassign region/subregion/sales channel/manager | `canReassignCustomers` | `admin`, `sales_director`, `ceo`. |
| Edit own sales channel on a customer they created | `canEditOwnSalesChannel` | `sales_manager` for customers with `created_by = self`; the reassign-capable roles above for any customer. |
| Link a customer to its ERP record | `canAssignErpCustomerId` | `admin`/`ceo`/`accountant` for any customer; `sales_manager`/`sales_director` only for customers they created. |

## Products and pricing

| Action | Function | Behavior |
|---|---|---|
| Create/edit products, set prices, manage promos, edit company profile | `canManageProducts` | `admin`, `ceo`, `accountant`. Sales roles can browse/generate a pricelist but not touch master pricing. |

## Orders

| Action | Function | Behavior |
|---|---|---|
| Confirm/reject/edit a submitted order before fulfillment | `canConfirmOrders` | `admin`, `sales_director`, `ceo`. |
| Plan for another rep's route (day-of or recurring) | `canPlanForOthers` | `admin`, `sales_director`, `ceo`. A plain `sales_manager` only plans for themselves. |

## Warehouse and delivery

| Action | Function | Behavior |
|---|---|---|
| Pick list / staging, mark packed, flag stock issue | `canManageWarehouse` | `warehouse_manager`, `sales_director`, `admin` (director covers the same ground while the warehouse role isn't in day-to-day use). |
| Plan/edit a delivery route | `canPlanRoutes` | `delivery_manager`, `admin`. |
| Act as a driver (confirm/fail a delivery stop) | `canDeliverOrders` | `delivery_manager`, `admin`. |
| Manual override: mark delivered without a planned route | `canMarkDeliveredWithoutRoute` | `delivery_manager`, `sales_director`, `accountant`, `ceo`, `admin`. |
| Check/uncheck the accountant's "Recorded" flag on a delivered order | `canRecordOrders` | `accountant`, `admin`. |

`isFulfillmentRole` = `canManageWarehouse` OR `canDeliverOrders` — the
shared set used to gate the order status-transition endpoints.

## Payments and cash custody

| Action | Function | Behavior |
|---|---|---|
| Approve/reject/reverse a submitted payment | `canReviewPayments` | `admin`, `ceo`, `accountant`. Not `sales_director`. |
| Submit a payment on someone else's behalf | `canSubmitPaymentsForOthers` | `admin`, `ceo`, `accountant`, `sales_director`. A plain `sales_manager` always self-submits. |
| Declare a cash handoff on someone else's behalf | `canSubmitHandoffForOthers` (= `canSubmitPaymentsForOthers`) | Same as above. |
| Receive a cash handoff | `validHandoffRecipientRoles(fromRole)` | Chain: `sales_manager → sales_director → (ceo \| accountant)`. `ceo` can only forward to `accountant`. See [`data-model.md`](data-model.md) for the underlying table. |
| Terminal custody (flips the payment to `approved`) | `isTerminalHandoffRole` | `accountant` only — a `ceo` confirming mid-chain leaves the payment `pending`. |

Push notifications for payments go only to `accountant`
(`PAYMENT_NOTIFY_ROLES`) — explicitly not `ceo`/`admin`, who can still
review in-app but shouldn't be paged for every single payment.

## Team Performance

| Action | Function | Behavior |
|---|---|---|
| Create/edit a draft plan for a channel | `canEditChannelPlan(role, ownerRole)` | CEO/admin: any channel. `sales_director`: only director-owned channels. `accountant`: only accountant-owned channels (KF/CAS). |
| Approve/reject a submitted plan | `canReviewPlan(role, submittedByRole)` | CEO/admin: any. `accountant`: only director-submitted plans (never their own). A director can never approve their own submission. |
| Create a new revision of an approved plan | `canReviseApprovedPlan` | CEO/admin only — the one mandatory-immutability rule in the workflow. |
| Pull a plan back to draft | `canReopenPlanAsDraft` | CEO/admin, `sales_director`, `accountant`. |
| Close a month (freeze final numbers) | `canCloseMonth` | CEO/admin, `accountant` — a finance-close action, not a director one. |

`isPerfCeo(role)` = `admin` OR `ceo`, used throughout the above as the
shorthand for "full authority."

## Where this is enforced

Every function above lives in `server/src/roles.js` and is imported
directly into route handlers (`server/src/routes/*.js`) — there is no
central "permission table" separate from the code. If this doc and the
code ever disagree, the code wins; open a PR to fix whichever is wrong.
