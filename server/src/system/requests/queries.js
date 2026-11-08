// The SQL of the request card and the Requests list (rules.js says who may decide). Every kind is read from its OWN table -- this module
// stores nothing: approving or denying still goes through each kind's own endpoint, with its own checks (orders.js, editRequests.js,
// payments.js, cashflow.js, visitPlans.js, teamPerformance.js, bonusRewardClaims.js, orderReturns.js).
import { orderCostCheck, effectiveDiscountPct } from "../../orders/discountPolicy.js";

const n = (v) => (v === null || v === undefined ? null : Number(v));

// One row per request waiting for a decision: { kind, id, requested_by_id, requested_by_name, requested_at, customer_name, erp_id,
// amount_amd, extra, facts }. `extra` is a short second line (order code, plan date, ...).
const PENDING_SQL = {
  discount: `SELECT o.id, o.user_id AS requested_by_id, u.name AS requested_by_name, o.updated_at AS requested_at, c.name AS customer_name,
                    c.erp_customer_id AS erp_id, o.total_amd AS amount_amd, o.order_code AS extra, o.customer_id, o.discount_pct, o.discount_amd
             FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.user_id
             WHERE o.approval_status = 'pending' AND o.status <> 'draft' AND o.cancelled_at IS NULL`,
  return: `SELECT r.id, r.requested_by AS requested_by_id, u.name AS requested_by_name, r.requested_at, c.name AS customer_name,
                  c.erp_customer_id AS erp_id, r.credit_amd AS amount_amd, r.kind AS extra
           FROM order_returns r JOIN customers c ON c.id = r.customer_id LEFT JOIN users u ON u.id = r.requested_by
           WHERE r.status = 'requested'`,
  customer_edit: `SELECT q.id, q.requested_by AS requested_by_id, u.name AS requested_by_name, q.created_at AS requested_at, c.name AS customer_name,
                         c.erp_customer_id AS erp_id, NULL::numeric AS amount_amd, array_to_string(ARRAY(SELECT jsonb_object_keys(q.changes)), ',') AS extra
                  FROM customer_edit_requests q JOIN customers c ON c.id = q.customer_id LEFT JOIN users u ON u.id = q.requested_by
                  WHERE q.status = 'pending'`,
  payment: `SELECT p.id, p.created_by AS requested_by_id, u.name AS requested_by_name, p.created_at AS requested_at, p.customer_name_snapshot AS customer_name,
                   p.erp_customer_id_snapshot AS erp_id, p.amount_amd, p.sales_manager_name_snapshot AS extra
            FROM payments p LEFT JOIN users u ON u.id = p.created_by
            WHERE p.status = 'pending'`,
  cashflow: `SELECT r.id, r.requested_by AS requested_by_id, u.name AS requested_by_name, r.requested_at, NULL AS customer_name, NULL AS erp_id,
                    CASE WHEN e.currency = 'USD' THEN NULL ELSE e.amount END AS amount_amd, r.action AS extra
             FROM cash_entry_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN cash_entries e ON e.id = r.entry_id
             WHERE r.status = 'pending'`,
  visit_plan: `SELECT vp.id, vp.user_id AS requested_by_id, u.name AS requested_by_name, vp.created_at AS requested_at, NULL AS customer_name, NULL AS erp_id,
                      NULL::numeric AS amount_amd, vp.plan_date::text AS extra
               FROM visit_plans vp LEFT JOIN users u ON u.id = vp.user_id
               WHERE vp.status = 'pending'`,
  perf_plan: `SELECT p.id, p.submitted_by AS requested_by_id, u.name AS requested_by_name, p.submitted_at AS requested_at, NULL AS customer_name, NULL AS erp_id,
                     NULL::numeric AS amount_amd, to_char(p.month, 'YYYY-MM') AS extra, u.role AS submitted_by_role
              FROM perf_plans p LEFT JOIN users u ON u.id = p.submitted_by
              WHERE p.status = 'pending_approval'`,
  bonus_claim: `SELECT b.id, b.user_id AS requested_by_id, u.name AS requested_by_name, b.created_at AS requested_at, NULL AS customer_name, NULL AS erp_id,
                       b.amount_amd, t.title AS extra
                FROM bonus_reward_claims b LEFT JOIN users u ON u.id = b.user_id
                LEFT JOIN bonus_challenge_rounds r ON r.id = b.round_id LEFT JOIN bonus_challenge_templates t ON t.id = r.template_id
                WHERE b.status IN ('awaiting_validation', 'on_hold')`,
};

// The facts a kind's "who may decide" rule needs (rules.js mayDecide), for a pending row.
async function factsOf(db, kind, row) {
  if (kind === "discount") {
    const { rows: lines } = await db.query("SELECT product_id, unit_price_amd, quantity FROM order_items WHERE order_id = $1", [row.id]);
    const subtotal = lines.reduce((s, l) => s + Number(l.unit_price_amd) * Number(l.quantity), 0);
    const check = await orderCostCheck(db, lines, subtotal, Number(row.amount_amd), { customerId: row.customer_id });
    return { belowCost: check.belowCost, belowLanding: check.belowLanding };
  }
  if (kind === "perf_plan") return { submittedByRole: row.submitted_by_role ?? null };
  if (kind === "bonus_claim") return { claimantId: row.requested_by_id };
  return {};
}

// Every request waiting for a decision, of the given kinds, with its facts. `needsFacts(kind)` lets a caller skip the per-order cost check
// when the person's role decides every discount anyway (the badge count).
export async function pendingRequests(db, kinds, { needsFacts = () => true } = {}) {
  const perKind = await Promise.all(
    kinds.map(async (kind) => {
      try {
        const { rows } = await db.query(PENDING_SQL[kind]);
        return { kind, rows };
      } catch (err) {
        console.error(`Pending requests (${kind}) failed:`, err.message);
        return { kind, rows: [] };
      }
    })
  );
  const out = [];
  for (const { kind, rows } of perKind) {
    for (const row of rows) {
      const facts = needsFacts(kind) ? await factsOf(db, kind, row) : {};
      out.push({
        kind,
        id: row.id,
        requested_by_id: row.requested_by_id,
        requested_by_name: row.requested_by_name,
        requested_at: row.requested_at,
        customer_name: row.customer_name,
        erp_id: row.erp_id,
        amount_amd: row.amount_amd === null ? null : Math.round(Number(row.amount_amd)),
        extra: row.extra,
        facts,
      });
    }
  }
  return out;
}

const userName = async (db, id) => (id ? (await db.query("SELECT name FROM users WHERE id = $1", [id])).rows[0]?.name ?? null : null);

// One request, whatever its state, for the card. null = no such request.
// { kind, id, status: pending|approved|rejected|closed, requested_by_id, requested_by_name, requested_at, decided_by_name, decided_at,
//   decision_reason, customer: { id, name, erp_id } | null, amount_amd, note, facts, details, version, source_url }
export async function loadRequest(db, kind, id) {
  const loader = LOADERS[kind];
  if (!loader || !Number.isInteger(id) || id <= 0) return null;
  return loader(db, id);
}

const LOADERS = {
  async discount(db, id) {
    const { rows: [o] } = await db.query(
      `SELECT o.*, c.name AS customer_name, c.erp_customer_id, u.name AS requested_by_name, d.name AS decided_by_name
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.user_id LEFT JOIN users d ON d.id = o.approved_by
       WHERE o.id = $1`,
      [id]
    );
    if (!o) return null;
    const { rows: items } = await db.query(
      `SELECT oi.product_id, oi.product_name, oi.quantity, oi.unit_price_amd, oi.list_price_amd, oi.line_total_amd, p.unit AS size
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`,
      [id]
    );
    const subtotal = items.reduce((s, l) => s + Number(l.unit_price_amd) * Number(l.quantity), 0);
    const check = await orderCostCheck(db, items, subtotal, Number(o.total_amd), { customerId: o.customer_id });
    const belowLanding = new Set(check.belowLandingProductIds);
    const status = { pending: "pending", approved: "approved", rejected: "rejected" }[o.approval_status] ?? "closed";
    return {
      kind: "discount",
      id: o.id,
      // cancelled, or sent back to draft (POST /orders/:id/reject): nothing to decide until it is submitted again
      status: (o.cancelled_at || o.status === "draft") && status === "pending" ? "closed" : status,
      requested_by_id: o.user_id,
      requested_by_name: o.requested_by_name,
      requested_at: o.updated_at ?? o.created_at,
      decided_by_name: o.approved_by ? o.decided_by_name : null,
      decided_at: o.approved_by ? o.approved_at : null,
      decision_reason: o.approval_reason ?? null,
      customer: { id: o.customer_id, name: o.customer_name, erp_id: o.erp_customer_id },
      amount_amd: Math.round(Number(o.total_amd)),
      note: o.note,
      facts: { belowCost: check.belowCost, belowLanding: check.belowLanding },
      details: {
        order_code: o.order_code,
        order_status: o.status,
        subtotal_amd: Math.round(subtotal),
        discount_amd: Math.round(Math.max(0, subtotal - Number(o.total_amd))),
        discount_pct: Math.round(effectiveDiscountPct(subtotal, o.discount_pct, o.discount_amd) * 10) / 10,
        margin_pct: check.marginPct === null ? null : Math.round(check.marginPct * 10) / 10,
        below_cost: check.belowCost,
        below_landing: check.belowLanding,
        lines: items.map((l) => ({
          product_name: l.product_name,
          size: l.size,
          quantity: n(l.quantity),
          list_price_amd: l.list_price_amd === null ? null : Math.round(Number(l.list_price_amd)),
          unit_price_amd: Math.round(Number(l.unit_price_amd)),
          line_total_amd: Math.round(Number(l.line_total_amd)),
          below_landing: belowLanding.has(Number(l.product_id)),
        })),
      },
      source_url: `/#/orders?open=${o.id}`,
    };
  },

  async return(db, id) {
    const { rows: [r] } = await db.query(
      `SELECT r.*, o.order_code, c.name AS customer_name, c.erp_customer_id, u.name AS requested_by_name, d.name AS decided_by_name
       FROM order_returns r JOIN orders o ON o.id = r.order_id JOIN customers c ON c.id = r.customer_id
       LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by WHERE r.id = $1`,
      [id]
    );
    if (!r) return null;
    const { rows: items } = await db.query("SELECT product_name, quantity, line_credit_amd FROM order_return_items WHERE return_id = $1 ORDER BY id", [id]);
    return {
      kind: "return",
      id: r.id,
      status: r.status === "requested" ? "pending" : r.status === "rejected" ? "rejected" : "approved",
      requested_by_id: r.requested_by,
      requested_by_name: r.requested_by_name,
      requested_at: r.requested_at,
      decided_by_name: r.decided_by ? r.decided_by_name : null,
      decided_at: r.decided_at,
      decision_reason: r.status === "rejected" ? r.decision_note : null,
      customer: { id: r.customer_id, name: r.customer_name, erp_id: r.erp_customer_id },
      amount_amd: r.kind === "return" ? Math.round(Number(r.credit_amd)) : null,
      note: r.note,
      facts: {},
      details: {
        return_kind: r.kind,
        reason: r.reason,
        order_code: r.order_code,
        order_status: r.order_status_at_request,
        lines: items.map((l) => ({ product_name: l.product_name, quantity: n(l.quantity), line_credit_amd: Math.round(Number(l.line_credit_amd)) })),
      },
      source_url: "/#/returns",
    };
  },

  async customer_edit(db, id) {
    const { rows: [q] } = await db.query(
      `SELECT q.*, u.name AS requested_by_name, d.name AS decided_by_name FROM customer_edit_requests q
       LEFT JOIN users u ON u.id = q.requested_by LEFT JOIN users d ON d.id = q.reviewed_by WHERE q.id = $1`,
      [id]
    );
    if (!q) return null;
    const { rows: [c] } = await db.query("SELECT * FROM customers WHERE id = $1", [q.customer_id]);
    const changes = q.changes ?? {};
    // a manager is shown by name, not by id
    const managerIds = [changes.assigned_manager_id, c?.assigned_manager_id].map(Number).filter((v) => Number.isInteger(v) && v > 0);
    const { rows: managers } = managerIds.length ? await db.query("SELECT id, name FROM users WHERE id = ANY($1)", [managerIds]) : { rows: [] };
    const nameOf = new Map(managers.map((m) => [m.id, m.name]));
    const shown = (field, value) => (field === "assigned_manager_id" && value ? nameOf.get(Number(value)) ?? String(value) : value);
    return {
      kind: "customer_edit",
      id: q.id,
      status: q.status,
      requested_by_id: q.requested_by,
      requested_by_name: q.requested_by_name,
      requested_at: q.created_at,
      decided_by_name: q.reviewed_by ? q.decided_by_name : null,
      decided_at: q.reviewed_at,
      decision_reason: q.review_reason ?? null,
      customer: c ? { id: c.id, name: c.name, erp_id: c.erp_customer_id } : null,
      amount_amd: null,
      note: q.note,
      facts: {},
      details: {
        changes: Object.entries(changes).map(([field, value]) => ({ field, old: shown(field, c ? c[field] ?? null : null), new: shown(field, value) })),
      },
      source_url: c ? `/#/customers/${c.id}` : null,
    };
  },

  async payment(db, id) {
    const { rows: [p] } = await db.query(
      `SELECT p.*, u.name AS requested_by_name, a.name AS approved_by_name, r.name AS rejected_by_name, c.erp_customer_id AS customer_erp_id
       FROM payments p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN users a ON a.id = p.approved_by LEFT JOIN users r ON r.id = p.rejected_by
       LEFT JOIN customers c ON c.id = p.customer_id WHERE p.id = $1`,
      [id]
    );
    if (!p) return null;
    return {
      kind: "payment",
      id: p.id,
      status: p.status,
      requested_by_id: p.created_by,
      requested_by_name: p.requested_by_name,
      requested_at: p.created_at,
      decided_by_name: p.status === "approved" ? p.approved_by_name : p.status === "rejected" ? p.rejected_by_name : null,
      decided_at: p.status === "approved" ? p.approved_at : p.status === "rejected" ? p.rejected_at : null,
      decision_reason: p.status === "rejected" ? p.rejection_reason : null,
      customer: { id: p.customer_id, name: p.customer_name_snapshot, erp_id: p.customer_erp_id ?? p.erp_customer_id_snapshot },
      amount_amd: Math.round(Number(p.amount_amd)),
      note: p.note,
      facts: {},
      details: { payment_date: p.payment_date, manager_name: p.sales_manager_name_snapshot, sales_channel: p.sales_channel, in_handoff: Boolean(p.pending_handoff_id) },
      source_url: `/#/payments/${p.id}`,
    };
  },

  async cashflow(db, id) {
    const { rows: [r] } = await db.query(
      `SELECT r.*, u.name AS requested_by_name, d.name AS decided_by_name, e.entry_date::text AS entry_date, e.amount::float8 AS entry_amount,
              e.currency, e.info, cat.name AS category, acc.name AS account
       FROM cash_entry_requests r LEFT JOIN users u ON u.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN cash_entries e ON e.id = r.entry_id LEFT JOIN cash_categories cat ON cat.id = e.category_id LEFT JOIN cash_accounts acc ON acc.id = e.account_id
       WHERE r.id = $1`,
      [id]
    );
    if (!r) return null;
    const payload = r.payload ?? {};
    const { rows: names } = await db.query(
      `SELECT (SELECT name FROM cash_categories WHERE id = $1) AS category, (SELECT name FROM cash_accounts WHERE id = $2) AS account`,
      [Number(payload.category_id) || null, Number(payload.account_id) || null]
    );
    const now = { entry_date: r.entry_date, amount: r.entry_amount, category: r.category, account: r.account, info: r.info };
    const next = {
      entry_date: payload.entry_date ?? undefined,
      amount: payload.amount ?? undefined,
      category: payload.category_id !== undefined ? names[0]?.category ?? null : undefined,
      account: payload.account_id !== undefined ? names[0]?.account ?? null : undefined,
      info: payload.info ?? undefined,
    };
    const changes = r.action === "delete" ? [] : Object.keys(now).filter((f) => next[f] !== undefined && String(next[f] ?? "") !== String(now[f] ?? "")).map((f) => ({ field: f, old: now[f], new: next[f] }));
    return {
      kind: "cashflow",
      id: r.id,
      status: r.status,
      requested_by_id: r.requested_by,
      requested_by_name: r.requested_by_name,
      requested_at: r.requested_at,
      decided_by_name: r.decided_by ? r.decided_by_name : null,
      decided_at: r.decided_at,
      decision_reason: r.decision_reason ?? null,
      customer: null,
      amount_amd: r.entry_amount === null || r.currency === "USD" ? null : Math.round(Number(r.entry_amount)),
      note: r.reason,
      facts: {},
      details: { action: r.action, currency: r.currency, entry: now, changes },
      source_url: "/#/cashflow",
    };
  },

  async visit_plan(db, id) {
    const { rows: [vp] } = await db.query(
      `SELECT vp.*, vp.plan_date::text AS plan_date_text, u.name AS requested_by_name, d.name AS decided_by_name FROM visit_plans vp
       LEFT JOIN users u ON u.id = vp.user_id LEFT JOIN users d ON d.id = vp.reviewed_by WHERE vp.id = $1`,
      [id]
    );
    if (!vp) return null;
    const ids = vp.customer_ids ?? [];
    const { rows: customers } = ids.length ? await db.query("SELECT id, name, erp_customer_id FROM customers WHERE id = ANY($1)", [ids]) : { rows: [] };
    const byId = new Map(customers.map((c) => [c.id, c]));
    return {
      kind: "visit_plan",
      id: vp.id,
      status: vp.status,
      requested_by_id: vp.user_id,
      requested_by_name: vp.requested_by_name,
      requested_at: vp.created_at,
      decided_by_name: vp.reviewed_by ? vp.decided_by_name : null,
      decided_at: vp.reviewed_by ? vp.reviewed_at : null,
      decision_reason: vp.review_reason ?? null,
      customer: null,
      amount_amd: null,
      note: null,
      facts: {},
      details: {
        plan_date: vp.plan_date_text,
        stops: ids.map((cid) => byId.get(cid)).filter(Boolean).map((c) => ({ name: c.name, erp_id: c.erp_customer_id })),
      },
      source_url: "/#/settings?section=plan-approvals",
    };
  },

  async perf_plan(db, id) {
    const { rows: [p] } = await db.query(
      `SELECT p.*, to_char(p.month, 'YYYY-MM') AS month_text, u.name AS requested_by_name, u.role AS submitted_by_role, d.name AS decided_by_name
       FROM perf_plans p LEFT JOIN users u ON u.id = p.submitted_by LEFT JOIN users d ON d.id = p.approved_by WHERE p.id = $1`,
      [id]
    );
    if (!p) return null;
    const { rows: targets } = await db.query(
      `SELECT sc.name AS channel, t.sales_target_amd, t.collection_target_amd, t.new_customers_target
       FROM perf_plan_targets t LEFT JOIN sales_channels sc ON sc.id = t.channel_id WHERE t.plan_id = $1 ORDER BY sc.name`,
      [id]
    );
    const status = { pending_approval: "pending", rejected: "rejected", approved: "approved", closed: "approved", superseded: "approved" }[p.status] ?? "closed";
    return {
      kind: "perf_plan",
      id: p.id,
      status,
      requested_by_id: p.submitted_by,
      requested_by_name: p.requested_by_name,
      requested_at: p.submitted_at,
      decided_by_name: status === "approved" || status === "rejected" ? p.decided_by_name : null,
      decided_at: status === "approved" || status === "rejected" ? p.approved_at : null,
      decision_reason: status === "rejected" ? p.rejected_reason : null,
      customer: null,
      amount_amd: Math.round(targets.reduce((s, t) => s + Number(t.sales_target_amd), 0)),
      note: null,
      facts: { submittedByRole: p.submitted_by_role ?? null },
      details: {
        month: p.month_text,
        version: p.version,
        targets: targets.map((t) => ({
          channel: t.channel,
          sales_target_amd: Math.round(Number(t.sales_target_amd)),
          collection_target_amd: Math.round(Number(t.collection_target_amd)),
          new_customers_target: Number(t.new_customers_target),
        })),
      },
      source_url: "/#/team-performance?tab=approvals",
    };
  },

  async bonus_claim(db, id) {
    const { rows: [b] } = await db.query(
      `SELECT b.*, u.name AS requested_by_name, t.title AS challenge, r.start_at, r.end_at, a.name AS approved_by_name, x.name AS rejected_by_name
       FROM bonus_reward_claims b LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN bonus_challenge_rounds r ON r.id = b.round_id LEFT JOIN bonus_challenge_templates t ON t.id = r.template_id
       LEFT JOIN users a ON a.id = b.approved_by LEFT JOIN users x ON x.id = b.rejected_by WHERE b.id = $1`,
      [id]
    );
    if (!b) return null;
    const status = { awaiting_validation: "pending", on_hold: "pending", approved: "approved", paid: "approved", rejected: "rejected" }[b.status] ?? "closed";
    return {
      kind: "bonus_claim",
      id: b.id,
      status,
      requested_by_id: b.user_id,
      requested_by_name: b.requested_by_name,
      requested_at: b.created_at,
      decided_by_name: status === "approved" ? b.approved_by_name : status === "rejected" ? b.rejected_by_name : null,
      decided_at: status === "approved" ? b.approved_at : status === "rejected" ? b.rejected_at : null,
      decision_reason: status === "rejected" ? b.rejection_reason : null,
      customer: null,
      amount_amd: Math.round(Number(b.amount_amd)),
      note: b.status === "on_hold" ? b.hold_reason : null,
      facts: { claimantId: b.user_id },
      details: { challenge: b.challenge, start_at: b.start_at, end_at: b.end_at, on_hold: b.status === "on_hold" },
      version: b.version,
      source_url: "/#/settings?section=a-bonuses",
    };
  },
};

// The approvers a request's push goes to: every active person whose role may decide it (rules.js decides; this only lists the people).
export async function activeUsers(db) {
  const { rows } = await db.query("SELECT id, role FROM users WHERE status = 'active'");
  return rows;
}

// "The first one who decides closes it for the others": the request's still-unread notifications of everyone but the decider are read.
export async function closeRequestNotifications(db, url, deciderId) {
  await db.query("UPDATE notifications SET read_at = now() WHERE url = $1 AND read_at IS NULL AND user_id <> $2", [url, deciderId]);
}

export { userName };
