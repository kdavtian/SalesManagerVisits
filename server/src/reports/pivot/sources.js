// Pivot report data sources (owner, 2026-11-03: "one very smart and complete pivot: choose from all data, pivot and filter everything,
// choose the fields, export Excel / CSV / PDF"; admin and CEO only). Each source is a fixed FROM clause and a list of fields whose SQL is
// written HERE: the browser only names fields by key, it never sends SQL (query.js builds the statement from these and parameters).
//   field: { key, type: text|number|date|bool, expr, label: { en, hy }, join?: name of an extra join it needs, vk?: value label key
//            template for the screen (e.g. "order_status_{v}"), agg?: default aggregation for a number }
//   source: { key, label, from, joins?: { name: sql }, prepare?(db): params for :p0.. placeholders in joins, fields }
import { liveDebtors } from "../../money/liveDebt.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

const L = (en, hy) => ({ en, hy });
const day = (col) => `((${col} AT TIME ZONE 'Asia/Yerevan')::date)`;

// The customer's own fields, for every source that is about a customer (alias c, its rep u).
const CUSTOMER_JOIN = "LEFT JOIN users u ON u.id = c.assigned_manager_id";
function customerFields(prefix = "cust_") {
  return [
    { key: `${prefix}name`, type: "text", expr: "c.name", label: L("Customer", "Հաճախորդ") },
    { key: `${prefix}erp`, type: "text", expr: "c.erp_customer_id", label: L("Customer ID", "Հաճախորդի ID") },
    { key: `${prefix}tin`, type: "text", expr: "c.tin", label: L("TIN", "ՀՎՀՀ") },
    { key: `${prefix}legal`, type: "text", expr: "c.legal_name", label: L("Legal name", "Իրավաբանական անվանում") },
    { key: `${prefix}region`, type: "text", expr: "c.region", label: L("Region", "Մարզ"), vk: "region" },
    { key: `${prefix}subregion`, type: "text", expr: "c.subregion", label: L("Subregion", "Ենթաշրջան"), vk: "subregion" },
    { key: `${prefix}address`, type: "text", expr: "c.address", label: L("Address", "Հասցե") },
    { key: `${prefix}phone`, type: "text", expr: "c.phone", label: L("Phone", "Հեռախոս") },
    { key: `${prefix}channel`, type: "text", expr: "c.sales_channel", label: L("Sales channel", "Վաճառքի ալիք") },
    { key: `${prefix}tier`, type: "text", expr: "c.customer_tier", label: L("Tier", "Կարգավիճակ"), vk: "tier_{v}" },
    { key: `${prefix}potential`, type: "text", expr: "c.potential_level::text", label: L("Potential", "Հեռանկար"), vk: "pl_level_{v}" },
    { key: `${prefix}category`, type: "text", expr: "c.category", label: L("Category", "Կատեգորիա"), vk: "category_{v}" },
    { key: `${prefix}rep`, type: "text", expr: "u.name", label: L("Assigned manager", "Պատասխանատու մենեջեր") },
  ];
}

// Current shelf state per customer and brand group: the group's values from the latest visit that recorded that group (as the customer
// card shows it); `current` marks every value of that latest record (dense_rank: one visit's values share it), older visits' records
// are kept as history.
const SHELF_ROWS = `(SELECT ch.customer_id, ch.user_id, ch.timestamp, g.key AS grp, v.val,
        dense_rank() OVER (PARTITION BY ch.customer_id, g.key ORDER BY ch.timestamp DESC, ch.id DESC) = 1 AS is_current
   FROM checkins ch
   CROSS JOIN LATERAL jsonb_each(ch.brand_status) g
   CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.value) = 'array' THEN g.value ELSE '[]'::jsonb END) v(val)
  WHERE ch.brand_status IS NOT NULL)`;

export const SOURCES = [
  {
    key: "customers",
    label: L("Customers", "Հաճախորդներ"),
    from: `FROM customers c ${CUSTOMER_JOIN}`,
    joins: {
      creator: "LEFT JOIN users cb ON cb.id = c.created_by",
      erp: "LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id",
      live: "LEFT JOIN (SELECT unnest(:p0::int[]) AS id, unnest(:p1::float8[]) AS debt, unnest(:p2::float8[]) AS overdue) ld ON ld.id = c.id",
      visits: `LEFT JOIN LATERAL (SELECT max(ch.timestamp) AS last_visit, count(*) FILTER (WHERE ch.timestamp > now() - interval '90 days')::int AS visits_90
                                  FROM checkins ch WHERE ch.customer_id = c.id) lv ON true`,
      shelf: `LEFT JOIN LATERAL (SELECT string_agg(s.grp || ':' || s.val, ', ' ORDER BY s.grp, s.val) AS products
                                 FROM ${SHELF_ROWS} s WHERE s.customer_id = c.id AND s.is_current) sh ON true`,
    },
    // the live debt (money/liveDebt.js) of every customer who owes, joined in as two lists
    prepare: async (db, joins) => {
      if (!joins.has("live")) return [];
      const rows = await liveDebtors(db, { today: yerevanToday() });
      return [rows.map((r) => r.id), rows.map((r) => r.live.debt_amd), rows.map((r) => r.live.aging.overdue_amd)];
    },
    fields: [
      ...customerFields(""),
      { key: "email", type: "text", expr: "c.email", label: L("Email", "Էլ. փոստ") },
      { key: "created", type: "date", expr: day("c.created_at"), label: L("Added on", "Ավելացվել է") },
      { key: "created_by", type: "text", expr: "cb.name", join: "creator", label: L("Added by", "Ավելացրել է") },
      { key: "visit_days", type: "number", expr: "c.visit_frequency_days", label: L("Visit every (days)", "Այցելել ամեն (օր)"), agg: "avg" },
      { key: "credit_term", type: "number", expr: "c.credit_term_days", label: L("Payment term (days)", "Վճարման ժամկետ (օր)"), agg: "avg" },
      { key: "payment_method", type: "text", expr: "c.payment_method", label: L("Payment method", "Վճարման եղանակ"), vk: "payment_method_{v}" },
      { key: "credit_limit", type: "number", expr: "c.credit_limit_amd", label: L("Credit limit", "Վարկային սահմանաչափ") },
      { key: "frozen_credit", type: "number", expr: "c.frozen_credit_amd", label: L("Frozen credit", "Սառեցված վարկ") },
      { key: "counterfeit", type: "bool", expr: "COALESCE(c.counterfeit_flag, false)", label: L("Counterfeit flag", "Կեղծիքի նշան") },
      { key: "last_visit", type: "date", expr: day("lv.last_visit"), join: "visits", label: L("Last visit", "Վերջին այց") },
      { key: "visits_90", type: "number", expr: "COALESCE(lv.visits_90, 0)", join: "visits", label: L("Visits (90 days)", "Այցեր (90 օր)") },
      { key: "products", type: "text", expr: "sh.products", join: "shelf", label: L("Products at the shop", "Ապրանքները խանութում"), vk: "chips" },
      { key: "excel_channel", type: "text", expr: "erp.assigned_sales_rep", join: "erp", label: L("Excel channel", "Excel-ի ալիք") },
      { key: "excel_debt", type: "number", expr: "COALESCE(erp.debt_amd, 0)", join: "erp", label: L("Debt (Excel)", "Պարտք (Excel)") },
      { key: "live_debt", type: "number", expr: "COALESCE(ld.debt, 0)", join: "live", label: L("Debt (live)", "Պարտք (ընթացիկ)") },
      { key: "overdue", type: "number", expr: "COALESCE(ld.overdue, 0)", join: "live", label: L("Overdue debt", "Ժամկետանց պարտք") },
    ],
  },
  {
    key: "shop_products",
    label: L("Products at the shops", "Ապրանքները խանութներում"),
    from: `FROM ${SHELF_ROWS} s JOIN customers c ON c.id = s.customer_id ${CUSTOMER_JOIN} LEFT JOIN users su ON su.id = s.user_id`,
    fields: [
      { key: "group", type: "text", expr: "s.grp", label: L("Brand group", "Ապրանքանիշի խումբ"), vk: "brand_group_{v}" },
      { key: "product", type: "text", expr: "s.grp || ':' || s.val", label: L("Product / finding", "Ապրանք / արձանագրում"), vk: "chips" },
      { key: "current", type: "bool", expr: "s.is_current", label: L("Current (latest visit)", "Ընթացիկ (վերջին այց)") },
      { key: "recorded", type: "date", expr: day("s.timestamp"), label: L("Recorded on", "Արձանագրվել է") },
      { key: "recorded_by", type: "text", expr: "su.name", label: L("Recorded by", "Արձանագրել է") },
      ...customerFields(),
    ],
  },
  {
    key: "sales",
    label: L("Sales (Excel order lines)", "Վաճառք (Excel-ի պատվերի տողեր)"),
    from: `FROM erp_order_lines l LEFT JOIN customers c ON c.erp_customer_id = l.erp_customer_id ${CUSTOMER_JOIN}
           LEFT JOIN LATERAL (SELECT p.family, p.size_l FROM products p WHERE p.erp_product_id = l.product_id ORDER BY p.id LIMIT 1) pp ON true`,
    fields: [
      { key: "date", type: "date", expr: "l.order_date", label: L("Order date", "Պատվերի ամսաթիվ") },
      { key: "order", type: "text", expr: "l.order_id", label: L("Order", "Պատվեր") },
      { key: "product", type: "text", expr: "l.product_name", label: L("Product", "Ապրանք") },
      { key: "product_id", type: "text", expr: "l.product_id", label: L("Product ID", "Ապրանքի ID") },
      { key: "brand", type: "text", expr: "l.brand", label: L("Brand", "Ապրանքանիշ") },
      { key: "family", type: "text", expr: "pp.family", label: L("Product family", "Ապրանքի ընտանիք") },
      { key: "size", type: "text", expr: "l.size_l", label: L("Pack size", "Տարա") },
      { key: "qty", type: "number", expr: "l.qty", label: L("Quantity", "Քանակ") },
      {
        key: "liters",
        type: "number",
        expr: "l.qty * COALESCE(pp.size_l, NULLIF(regexp_replace(COALESCE(l.size_l, ''), '[^0-9.]', '', 'g'), '')::numeric, 0)",
        label: L("Liters", "Լիտր"),
      },
      { key: "revenue", type: "number", expr: "l.revenue_amd", label: L("Revenue (AMD)", "Հասույթ (դր)") },
      { key: "discount", type: "number", expr: "l.discount_amd", label: L("Discount (AMD)", "Զեղչ (դր)") },
      { key: "unit_price", type: "number", expr: "l.unit_price_amd", label: L("Unit price", "Միավորի գին"), agg: "avg" },
      { key: "excel_rep", type: "text", expr: "l.sales_rep", label: L("Excel channel / rep", "Excel-ի ալիք / մենեջեր") },
      { key: "erp_customer", type: "text", expr: "l.erp_customer_id", label: L("Excel customer ID", "Excel-ի հաճախորդի ID") },
      ...customerFields(),
    ],
  },
  {
    key: "app_orders",
    label: L("App orders", "Հավելվածի պատվերներ"),
    from: `FROM orders o JOIN customers c ON c.id = o.customer_id ${CUSTOMER_JOIN} LEFT JOIN users ou ON ou.id = o.user_id`,
    fields: [
      { key: "code", type: "text", expr: "o.order_code", label: L("Order", "Պատվեր") },
      { key: "created", type: "date", expr: day("o.created_at"), label: L("Created on", "Ստեղծվել է") },
      { key: "status", type: "text", expr: "o.status", label: L("Status", "Կարգավիճակ"), vk: "order_status_{v}" },
      { key: "made_by", type: "text", expr: "ou.name", label: L("Made by", "Կազմել է") },
      { key: "total", type: "number", expr: "o.total_amd", label: L("Total (AMD)", "Ընդամենը (դր)") },
      { key: "discount_amd", type: "number", expr: "COALESCE(o.discount_amd, 0)", label: L("Discount (AMD)", "Զեղչ (դր)") },
      { key: "discount_pct", type: "number", expr: "COALESCE(o.discount_pct, 0)", label: L("Discount %", "Զեղչ %"), agg: "avg" },
      { key: "payment_method", type: "text", expr: "o.payment_method", label: L("Payment method", "Վճարման եղանակ"), vk: "payment_method_{v}" },
      { key: "source", type: "text", expr: "o.order_source", label: L("Order source", "Պատվերի աղբյուր") },
      { key: "credit", type: "text", expr: "o.credit_status", label: L("Credit check", "Վարկի ստուգում") },
      { key: "in_excel", type: "bool", expr: "o.erp_matched_order_id IS NOT NULL", label: L("In Excel", "Excel-ում է") },
      { key: "via_app", type: "bool", expr: "COALESCE(o.placed_via_app, false)", label: L("Placed by the customer (KAD OS)", "Պատվիրել է հաճախորդը (KAD OS)") },
      { key: "promised", type: "date", expr: "o.promised_date", label: L("Promised date", "Խոստացված ամսաթիվ") },
      { key: "cancel_reason", type: "text", expr: "o.cancel_reason", label: L("Cancel reason", "Չեղարկման պատճառ") },
      ...customerFields(),
    ],
  },
  {
    key: "app_order_lines",
    label: L("App order lines", "Հավելվածի պատվերի տողեր"),
    from: `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id ${CUSTOMER_JOIN} LEFT JOIN users ou ON ou.id = o.user_id`,
    fields: [
      { key: "code", type: "text", expr: "o.order_code", label: L("Order", "Պատվեր") },
      { key: "created", type: "date", expr: day("o.created_at"), label: L("Created on", "Ստեղծվել է") },
      { key: "status", type: "text", expr: "o.status", label: L("Order status", "Պատվերի կարգավիճակ"), vk: "order_status_{v}" },
      { key: "made_by", type: "text", expr: "ou.name", label: L("Made by", "Կազմել է") },
      { key: "product", type: "text", expr: "oi.product_name", label: L("Product", "Ապրանք") },
      { key: "brand", type: "text", expr: "oi.brand", label: L("Brand", "Ապրանքանիշ") },
      { key: "qty", type: "number", expr: "oi.quantity", label: L("Quantity", "Քանակ") },
      { key: "unit_price", type: "number", expr: "oi.unit_price_amd", label: L("Unit price", "Միավորի գին"), agg: "avg" },
      { key: "list_price", type: "number", expr: "oi.list_price_amd", label: L("List price", "Գնացուցակի գին"), agg: "avg" },
      { key: "line_total", type: "number", expr: "oi.line_total_amd", label: L("Line total (AMD)", "Տողի գումար (դր)") },
      ...customerFields(),
    ],
  },
  {
    key: "visits",
    label: L("Visits (check-ins)", "Այցեր (չեք-ին)"),
    from: `FROM checkins ch JOIN customers c ON c.id = ch.customer_id ${CUSTOMER_JOIN} LEFT JOIN users vu ON vu.id = ch.user_id`,
    fields: [
      { key: "date", type: "date", expr: day("ch.timestamp"), label: L("Visit date", "Այցի ամսաթիվ") },
      { key: "hour", type: "number", expr: "EXTRACT(HOUR FROM ch.timestamp AT TIME ZONE 'Asia/Yerevan')::int", label: L("Hour", "Ժամ"), agg: "avg" },
      { key: "by", type: "text", expr: "vu.name", label: L("Visited by", "Այցելել է") },
      { key: "outcomes", type: "text", expr: "array_to_string(ch.outcomes, ', ')", label: L("Outcome", "Արդյունք"), vk: "outcome_{v}" },
      { key: "within", type: "bool", expr: "COALESCE(ch.within_range, false)", label: L("At the shop (in range)", "Խանութում (շառավղում)") },
      { key: "distance", type: "number", expr: "ch.distance_meters", label: L("Distance from the shop (m)", "Հեռավորությունը խանութից (մ)"), agg: "avg" },
      { key: "minutes", type: "number", expr: "ROUND(EXTRACT(EPOCH FROM (ch.ended_at - ch.timestamp)) / 60)", label: L("Visit length (min)", "Այցի տևողություն (րոպե)"), agg: "avg" },
      { key: "collected", type: "number", expr: "COALESCE(ch.amount_collected_amd, 0)", label: L("Cash collected (AMD)", "Հավաքագրված (դր)") },
      { key: "note", type: "text", expr: "ch.note", label: L("Note", "Նշում") },
      ...customerFields(),
    ],
  },
  {
    key: "payments",
    label: L("Payments collected (app)", "Հավաքագրված վճարումներ (հավելված)"),
    from: `FROM payments p JOIN customers c ON c.id = p.customer_id ${CUSTOMER_JOIN} LEFT JOIN users pu ON pu.id = p.sales_manager_id`,
    fields: [
      { key: "date", type: "date", expr: day("p.payment_date"), label: L("Payment date", "Վճարման ամսաթիվ") },
      { key: "amount", type: "number", expr: "p.amount_amd", label: L("Amount (AMD)", "Գումար (դր)") },
      { key: "status", type: "text", expr: "p.status", label: L("Status", "Կարգավիճակ"), vk: "payment_status_{v}" },
      { key: "collector", type: "text", expr: "COALESCE(pu.name, p.sales_manager_name_snapshot)", label: L("Collected by", "Հավաքագրել է") },
      { key: "channel", type: "text", expr: "p.sales_channel", label: L("Channel (at payment)", "Ալիք (վճարման պահին)") },
      { key: "confirmation", type: "text", expr: "p.customer_confirmation", label: L("Customer confirmation", "Հաճախորդի հաստատում") },
      { key: "in_excel", type: "bool", expr: "COALESCE(p.approved_from_erp, false) OR p.erp_match_key IS NOT NULL", label: L("In Excel", "Excel-ում է") },
      ...customerFields(),
    ],
  },
  {
    key: "money_ledger",
    label: L("Payments ledger (cash, bank, card)", "Վճարումների մատյան (կանխիկ, բանկ, քարտ)"),
    from: `FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.customer_id ${CUSTOMER_JOIN}
           LEFT JOIN cash_accounts ca ON ca.id = cp.account_id LEFT JOIN users cu2 ON cu2.id = cp.collected_by`,
    fields: [
      { key: "date", type: "date", expr: "cp.pay_day", label: L("Payment date", "Վճարման ամսաթիվ") },
      { key: "amount", type: "number", expr: "cp.amount_amd", label: L("Amount (AMD)", "Գումար (դր)") },
      { key: "method", type: "text", expr: "cp.method", label: L("Method", "Եղանակ"), vk: "pv_method_{v}" },
      { key: "account", type: "text", expr: "ca.name", label: L("Account / desk", "Հաշիվ / դրամարկղ") },
      { key: "source", type: "text", expr: "cp.source", label: L("Recorded from", "Գրանցման աղբյուր") },
      { key: "books", type: "text", expr: "cp.books_state", label: L("Excel state", "Excel-ի վիճակ") },
      { key: "cash_state", type: "text", expr: "cp.cash_state", label: L("Cash state", "Կանխիկի վիճակ") },
      { key: "voided", type: "bool", expr: "cp.voided_at IS NOT NULL", label: L("Voided", "Չեղարկված") },
      { key: "collector", type: "text", expr: "cu2.name", label: L("Collected / typed by", "Հավաքագրել / մուտքագրել է") },
      ...customerFields(),
    ],
  },
  {
    key: "tasks",
    label: L("Tasks", "Առաջադրանքներ"),
    from: `FROM tasks t LEFT JOIN customers c ON c.id = t.customer_id ${CUSTOMER_JOIN}
           LEFT JOIN users ta ON ta.id = t.assignee_id LEFT JOIN users tc ON tc.id = t.creator_id`,
    fields: [
      { key: "title", type: "text", expr: "t.title", label: L("Task", "Առաջադրանք") },
      { key: "kind", type: "text", expr: "COALESCE(t.task_kind, t.auto_kind)", label: L("Kind", "Տեսակ") },
      { key: "auto", type: "bool", expr: "t.auto_kind IS NOT NULL", label: L("Automatic (Vaghinak)", "Ավտոմատ (Վաղինակ)") },
      { key: "request", type: "bool", expr: "COALESCE(t.is_request, false)", label: L("Request", "Խնդրանք") },
      { key: "status", type: "text", expr: "t.status", label: L("Status", "Կարգավիճակ"), vk: "task_status_{v}" },
      { key: "outcome", type: "text", expr: "t.outcome", label: L("Outcome", "Արդյունք") },
      { key: "assignee", type: "text", expr: "ta.name", label: L("Assignee", "Կատարող") },
      { key: "creator", type: "text", expr: "tc.name", label: L("Given by", "Տվել է") },
      { key: "created", type: "date", expr: day("t.created_at"), label: L("Created on", "Ստեղծվել է") },
      { key: "due", type: "date", expr: "t.due_date", label: L("Due date", "Ժամկետ") },
      { key: "completed", type: "date", expr: day("t.completed_at"), label: L("Completed on", "Կատարվել է") },
      { key: "late", type: "bool", expr: "t.status = 'open' AND t.due_date < (now() AT TIME ZONE 'Asia/Yerevan')::date", label: L("Late", "Ուշացած") },
      ...customerFields(),
    ],
  },
  {
    key: "products",
    label: L("Products and stock", "Ապրանքներ և պաշար"),
    from: "FROM products p",
    fields: [
      { key: "name", type: "text", expr: "p.name", label: L("Product", "Ապրանք") },
      { key: "sku", type: "text", expr: "p.sku", label: L("SKU", "Կոդ") },
      { key: "erp_id", type: "text", expr: "p.erp_product_id", label: L("Excel product ID", "Excel-ի ապրանքի ID") },
      { key: "brand", type: "text", expr: "p.brand", label: L("Brand", "Ապրանքանիշ") },
      { key: "family", type: "text", expr: "p.family", label: L("Family", "Ընտանիք") },
      { key: "size", type: "number", expr: "p.size_l", label: L("Pack size (L)", "Տարա (լ)"), agg: "avg" },
      { key: "active", type: "bool", expr: "COALESCE(p.active, false)", label: L("Active", "Ակտիվ") },
      { key: "commercial", type: "bool", expr: "COALESCE(p.is_commercial, false)", label: L("Commercial", "Կոմերցիոն") },
      { key: "stock", type: "number", expr: "COALESCE(p.stock_qty, 0)", label: L("Stock (pcs)", "Պաշար (հատ)") },
      { key: "stock_liters", type: "number", expr: "COALESCE(p.stock_qty, 0) * COALESCE(p.size_l, 0)", label: L("Stock (L)", "Պաշար (լ)") },
      { key: "bronze", type: "number", expr: "p.bronze_price_amd", label: L("Bronze price", "Բրոնզե գին"), agg: "avg" },
      { key: "silver", type: "number", expr: "p.silver_price_amd", label: L("Silver price", "Արծաթե գին"), agg: "avg" },
      { key: "gold", type: "number", expr: "p.gold_price_amd", label: L("Gold price", "Ոսկե գին"), agg: "avg" },
      { key: "retail", type: "number", expr: "p.retail_price_amd", label: L("Retail price", "Մանրածախ գին"), agg: "avg" },
      { key: "net_cost", type: "number", expr: "p.net_cost_amd", label: L("Net cost", "Զուտ ինքնարժեք"), agg: "avg" },
      { key: "landing_cost", type: "number", expr: "p.landing_cost_amd", label: L("Landing cost", "Ներմուծման ինքնարժեք"), agg: "avg" },
      { key: "stock_value", type: "number", expr: "COALESCE(p.stock_qty, 0) * COALESCE(p.net_cost_amd, 0)", label: L("Stock value at net cost", "Պաշարի արժեք (զուտ ինքնարժեքով)") },
    ],
  },
  {
    key: "route_plans",
    label: L("Route plans", "Երթուղային պլաններ"),
    from: `FROM visit_plan_rules r CROSS JOIN LATERAL unnest(r.customer_ids) WITH ORDINALITY x(cid, pos)
           JOIN customers c ON c.id = x.cid ${CUSTOMER_JOIN} LEFT JOIN users ru ON ru.id = r.user_id`,
    fields: [
      { key: "planned_for", type: "text", expr: "ru.name", label: L("Planned for", "Պլանավորված է") },
      { key: "weekday", type: "text", expr: "r.day_of_week::text", label: L("Weekday", "Շաբաթվա օր"), vk: "rp_auto_day_{v}" },
      { key: "position", type: "number", expr: "x.pos", label: L("Order in the day", "Հերթը օրվա մեջ"), agg: "avg" },
      { key: "active", type: "bool", expr: "r.active", label: L("Active", "Ակտիվ") },
      ...customerFields(),
    ],
  },
  {
    key: "cashflow",
    label: L("Cashflow", "Դրամական հոսքեր"),
    from: `FROM cash_entries e LEFT JOIN cash_categories cc ON cc.id = e.category_id LEFT JOIN cash_accounts ca ON ca.id = e.account_id
           LEFT JOIN customers c ON c.erp_customer_id = e.erp_customer_id ${CUSTOMER_JOIN}`,
    fields: [
      { key: "date", type: "date", expr: "e.entry_date", label: L("Date", "Ամսաթիվ") },
      { key: "amount", type: "number", expr: "e.amount_amd", label: L("Amount (AMD)", "Գումար (դր)") },
      { key: "direction", type: "text", expr: "CASE WHEN e.amount_amd >= 0 THEN 'in' ELSE 'out' END", label: L("In / out", "Մուտք / ելք"), vk: "pv_dir_{v}" },
      { key: "amount_orig", type: "number", expr: "e.amount", label: L("Amount (currency)", "Գումար (արժույթով)") },
      { key: "currency", type: "text", expr: "e.currency", label: L("Currency", "Արժույթ") },
      { key: "category", type: "text", expr: "cc.name", label: L("Category", "Հոդված") },
      { key: "category_kind", type: "text", expr: "cc.kind", label: L("Category kind", "Հոդվածի տեսակ") },
      { key: "account", type: "text", expr: "ca.name", label: L("Account", "Հաշիվ") },
      { key: "account_kind", type: "text", expr: "ca.kind", label: L("Account kind", "Հաշվի տեսակ") },
      { key: "excel_rep", type: "text", expr: "e.sales_rep", label: L("Excel rep", "Excel-ի մենեջեր") },
      { key: "info", type: "text", expr: "e.info", label: L("Info", "Տեղեկություն") },
      { key: "ref", type: "text", expr: "e.ref", label: L("Reference", "Հղում") },
      { key: "origin", type: "text", expr: "e.origin", label: L("Recorded from", "Գրանցման աղբյուր") },
      { key: "cust_name", type: "text", expr: "c.name", label: L("Customer", "Հաճախորդ") },
      { key: "cust_erp", type: "text", expr: "e.erp_customer_id", label: L("Customer ID", "Հաճախորդի ID") },
      { key: "cust_rep", type: "text", expr: "u.name", label: L("Assigned manager", "Պատասխանատու մենեջեր") },
    ],
  },
  {
    key: "staff",
    label: L("Staff", "Աշխատակազմ"),
    from: "FROM users s",
    where: "s.role <> 'customer'",
    fields: [
      { key: "name", type: "text", expr: "s.name", label: L("Name", "Անուն") },
      { key: "role", type: "text", expr: "s.role", label: L("Role", "Դեր"), vk: "role_{v}" },
      { key: "position", type: "text", expr: "s.position", label: L("Position", "Պաշտոն") },
      { key: "status", type: "text", expr: "s.status", label: L("Status", "Կարգավիճակ") },
      { key: "phone", type: "text", expr: "s.phone", label: L("Phone", "Հեռախոս") },
      { key: "created", type: "date", expr: day("s.created_at"), label: L("Added on", "Ավելացվել է") },
      { key: "last_seen", type: "date", expr: day("s.last_seen_at"), label: L("Last seen", "Վերջին մուտք") },
      { key: "app_version", type: "text", expr: "s.last_seen_app_version", label: L("App version", "Հավելվածի տարբերակ") },
    ],
  },
];

export const SOURCE_BY_KEY = new Map(SOURCES.map((s) => [s.key, s]));

// What the screen needs: no SQL, only keys, types, labels and value-label templates.
export function catalog() {
  return SOURCES.map((s) => ({
    key: s.key,
    label: s.label,
    fields: s.fields.map((f) => ({ key: f.key, type: f.type, label: f.label, vk: f.vk ?? null, agg: f.agg ?? (f.type === "number" ? "sum" : "count") })),
  }));
}
