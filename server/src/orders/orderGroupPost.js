// A confirmed order goes to the accounting Telegram group at once (owner, 2026-11-23): "when sales director approves an order, send
// the details to the accountants so that they see immediately and know details to include in waybill or invoice".
//
// ONE function decides what the group must be told about an order: syncOrderPost(orderId). It compares what the order is NOW with the
// last thing the group was told, and writes the missing message. Because it looks at the state, not at the button that was tapped, it
// is safe to call from anywhere, twice, late, or out of order:
//   order is confirmed (or already packed / delivered)   and the group knows nothing        -> its details
//   ... and the group has other details (lines, prices, payment method, a test order ...)   -> the details again, marked CHANGED
//   order went back to submitted / draft                 and the group has its details      -> "do not issue yet"
//   order was cancelled or deleted                       and the group has heard of it      -> "cancelled, do not issue"
// A message the bot has not taken yet is corrected or withdrawn in place instead of being followed by a second one.
// Callers: the routes that change an order (right away), and the job "order-group-posts" every minute, which catches every other path
// and any call that failed. Only orders confirmed since the switch was last turned on are announced (no flood of old orders).
//
// The texts are frozen in group_posts (migration 222); the CEO bot takes them (erpSync /group-posts) and posts to the group of the daily
// cash sheets. Switch: app_settings.order_confirm_telegram (App configuration, ON by default). OFF = no new announcements; an order the
// group already has details of is still corrected or taken back. Nothing here ever throws into the caller.
import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { effectiveDiscountPct } from "./discountPolicy.js";

// the statuses in which the order's document is (or was) to be issued from these details
const DOCUMENT_STATUSES = ["confirmed", "packed_stock_out", "delivered", "recorded"];
const CLAIM_MINUTES = 2; // a message the bot took and did not report is offered again after this
const OFFER_DAYS = 3; // a message nobody could post for this long is not posted late (an outage does not end in a flood)

const amd = (v) => `${Math.round(Number(v) || 0).toLocaleString("en-US")} դր`;

export async function getOrderConfirmTelegram(db = pool) {
  const { rows } = await db.query("SELECT order_confirm_telegram FROM app_settings WHERE id = 1");
  return rows[0]?.order_confirm_telegram ?? true;
}

// Turning it ON starts from now: orders confirmed while it was off are not announced afterwards.
export async function setOrderConfirmTelegram(enabled) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, order_confirm_telegram) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET order_confirm_telegram_since = CASE WHEN EXCLUDED.order_confirm_telegram AND NOT app_settings.order_confirm_telegram
                                                                        THEN now() ELSE app_settings.order_confirm_telegram_since END,
                                    order_confirm_telegram = EXCLUDED.order_confirm_telegram
     RETURNING order_confirm_telegram`,
    [enabled]
  );
  return rows[0].order_confirm_telegram;
}

async function loadFacts(db, orderId) {
  const { rows: [o] } = await db.query(
    `SELECT o.id, o.order_code, o.status, o.cancelled_at, o.cancel_reason, o.total_amd, o.note, o.discount_pct, o.discount_amd, o.payment_method,
            o.payment_term_days, o.downpayment_amd, to_char(o.promised_date, 'DD.MM.YYYY') AS promised, COALESCE(o.accounting_is_test, false) AS is_test,
            c.name AS customer, c.erp_customer_id, c.tin, c.legal_name, c.legal_address, c.address, u.name AS rep,
            conf.changed_at AS confirmed_at, cu.name AS confirmed_by
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN LATERAL (SELECT h.changed_at, h.changed_by FROM order_status_history h
                        WHERE h.order_id = o.id AND h.new_status = 'confirmed' ORDER BY h.changed_at DESC, h.id DESC LIMIT 1) conf ON true
     LEFT JOIN users cu ON cu.id = conf.changed_by
     WHERE o.id = $1`,
    [orderId]
  );
  if (!o) return null;
  const { rows: items } = await db.query(
    `SELECT oi.product_name, oi.quantity, oi.unit_price_amd, oi.line_total_amd, p.unit AS size
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId]
  );
  return { ...o, items };
}

const codeOf = (o) => o.order_code ?? `#${o.id}`;
// "4L" after the name unless the name already says it; a plain piece ("pcs", "հատ") is not a size worth printing
const sizeSuffix = (it) => {
  const size = String(it.size ?? "").trim();
  if (!size || /^(pcs?|հատ|шт\.?)$/i.test(size)) return "";
  return String(it.product_name).toLowerCase().includes(size.toLowerCase()) ? "" : ` ${size}`;
};

/** The details, without the heading line: what the document is issued from. Its hash says whether the group's copy is still right. */
export function orderDetailsText(o) {
  const invoice = o.payment_method === "invoice";
  const lines = [];
  if (o.is_test) lines.push("🧪 ԹԵՍՏԱՅԻՆ պատվեր՝ իրական փաստաթուղթ պետք չէ", "");
  lines.push(`Փաստաթուղթ՝ ${invoice ? "հաշիվ-ապրանքագիր (փոխանցում)" : "բեռնագիր (կանխիկ)"}`, "");
  lines.push(`Հաճախորդ՝ ${o.customer}${o.erp_customer_id ? ` · ID ${o.erp_customer_id}` : " · ⚠️ ERP ID չկա"}`);
  if (invoice) {
    if (o.legal_name) lines.push(`Իրավաբանական անվանում՝ ${o.legal_name}`);
    lines.push(`ՀՎՀՀ՝ ${o.tin || "⚠️ չկա"}`);
    if (o.legal_address) lines.push(`Իրավաբանական հասցե՝ ${o.legal_address}`);
  }
  if (o.address) lines.push(`Հասցե՝ ${o.address}`);
  lines.push("");
  o.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.product_name}${sizeSuffix(it)}`, `   ${Number(it.quantity)} հատ × ${amd(it.unit_price_amd)} = ${amd(it.line_total_amd)}`);
  });
  lines.push("");
  const subtotal = o.items.reduce((s, it) => s + Number(it.line_total_amd || 0), 0);
  const discountAmd = Math.round(subtotal - Number(o.total_amd || 0));
  if (discountAmd > 0) {
    const pct = effectiveDiscountPct(subtotal, Number(o.discount_pct || 0), Number(o.discount_amd || 0));
    lines.push(`Գումար՝ ${amd(subtotal)}`, `Զեղչ՝ ${amd(discountAmd)}${pct ? ` (${Math.round(pct * 10) / 10}%)` : ""}`);
  }
  lines.push(`Ընդամենը՝ ${amd(o.total_amd)}`);
  if (Number(o.payment_term_days) > 0) lines.push(`Վճարման ժամկետ՝ ${o.payment_term_days} օր`);
  if (Number(o.downpayment_amd) > 0) lines.push(`Կանխավճար՝ ${amd(o.downpayment_amd)}`);
  if (o.promised) lines.push(`Առաքում՝ ${o.promised}`);
  if (o.note) lines.push(`Նշում՝ ${o.note}`);
  return lines.join("\n");
}

/** The whole message, plain text (the bot sends it as it is). */
export function orderConfirmedText(o, { changed = false } = {}) {
  return [
    `${changed ? "♻️ Պատվերը ՓՈՓՈԽՎԵԼ է, սա նոր տարբերակն է" : "✅ Պատվերը հաստատված է"} · ${codeOf(o)}`,
    orderDetailsText(o),
    "",
    `Պատվիրեց՝ ${o.rep ?? "—"}${o.confirmed_by ? ` · Հաստատեց՝ ${o.confirmed_by}` : ""}`,
  ].join("\n");
}

export function orderWithdrawnText({ title, cancelled = false, by = null, reason = null }) {
  return [
    `${cancelled ? "❌ Պատվերը ՉԵՂԱՐԿՎԵԼ է" : "⏸ Պատվերը վերադարձվել է փոփոխման"} · ${title}`,
    cancelled ? "Փաստաթուղթ մի՛ դուրս գրեք։" : "Փաստաթուղթ դեռ մի՛ դուրս գրեք. նորից հաստատվելիս կգա նոր հաղորդագրություն։",
    reason ? `Պատճառ՝ ${reason}` : null,
    by ? `${cancelled ? "Որոշեց" : "Վերադարձրեց"}՝ ${by}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const hashOf = (text) => crypto.createHash("sha1").update(text).digest("hex");
const userName = async (db, id) => (id ? (await db.query("SELECT name FROM users WHERE id = $1", [id])).rows[0]?.name ?? null : null);

/**
 * Tell the group whatever it does not know yet about this order. { byId, reason }: who moved it back / cancelled it and why, when the
 * caller knows (the job does not). Returns what it did: "announced" | "changed" | "corrected" | "withdrawn" | "taken_back" |
 * "cancelled" | null (nothing to say). Never throws.
 */
export async function syncOrderPost(orderId, { byId = null, reason = null } = {}, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // one order at a time: two calls for the same order (a hook and the job, a quick confirm / move back) decide one after the other
    await client.query("SELECT pg_advisory_xact_lock(7222, $1)", [orderId]);
    const did = await decide(client, orderId, { byId, reason });
    await client.query("COMMIT");
    return did;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`Order ${orderId}: the group message could not be written:`, err.message);
    return null;
  } finally {
    client.release();
  }
}

async function decide(db, orderId, { byId, reason }) {
  const { rows: [settings] } = await db.query("SELECT order_confirm_telegram AS on, order_confirm_telegram_since AS since FROM app_settings WHERE id = 1");
  const { rows: [last] } = await db.query("SELECT id, kind, title, content_hash, posted_at, claimed_at FROM group_posts WHERE ref_id = $1 ORDER BY id DESC LIMIT 1", [orderId]);
  const o = await loadFacts(db, orderId);
  // not taken by the bot yet: it can still be corrected or withdrawn without anybody having read it
  const untouched = last && !last.posted_at && !last.claimed_at;
  const insert = (kind, title, text, hash = null) => db.query("INSERT INTO group_posts (kind, ref_id, title, text, content_hash) VALUES ($1, $2, $3, $4, $5)", [kind, orderId, title, text, hash]);

  const live = o && !o.cancelled_at && DOCUMENT_STATUSES.includes(o.status);
  if (live) {
    const title = `${codeOf(o)} · ${o.customer}`;
    const hash = hashOf(orderDetailsText(o));
    if (last?.kind === "order_confirmed") {
      if (last.content_hash === hash) return null;
      if (untouched) {
        await db.query("UPDATE group_posts SET text = $2, content_hash = $3, title = $4 WHERE id = $1", [last.id, orderConfirmedText(o), hash, title]);
        return "corrected";
      }
      await insert("order_confirmed", title, orderConfirmedText(o, { changed: true }), hash);
      return "changed";
    }
    // a first announcement (or one after "moved back"): only while switched on, and only for an order confirmed since it was switched on
    if (!settings?.on) return null;
    if (!o.confirmed_at || (settings.since && new Date(o.confirmed_at) < new Date(settings.since))) return null;
    await insert("order_confirmed", title, orderConfirmedText(o, { changed: Boolean(last) }), hash);
    return last ? "changed" : "announced";
  }

  // no document is to be issued any more: moved back, cancelled, or deleted
  if (!last || last.kind === "order_cancelled") return null;
  const gone = !o || Boolean(o.cancelled_at);
  if (last.kind === "order_unconfirmed" && !gone) return null;
  if (last.kind === "order_confirmed" && untouched) {
    // its details never left the app: the waiting message is withdrawn; if nothing older reached the group there is nothing to take back
    await db.query("DELETE FROM group_posts WHERE id = $1 AND posted_at IS NULL AND claimed_at IS NULL", [last.id]);
    const { rows: [older] } = await db.query("SELECT kind FROM group_posts WHERE ref_id = $1 ORDER BY id DESC LIMIT 1", [orderId]);
    if (!older || older.kind === "order_cancelled" || (older.kind === "order_unconfirmed" && !gone)) return "withdrawn";
  }
  const title = o ? `${codeOf(o)} · ${o.customer}` : last.title ?? `#${orderId}`;
  const by = await userName(db, byId);
  await insert(gone ? "order_cancelled" : "order_unconfirmed", title, orderWithdrawnText({ title, cancelled: gone, by, reason: reason ?? (o?.cancelled_at ? o.cancel_reason : null) }));
  return gone ? "cancelled" : "taken_back";
}

/** For a route: after its own answer went out, without waiting and without ever failing it. */
export function syncOrderPostSoon(orderId, opts) {
  syncOrderPost(orderId, opts).catch(() => {});
}

/**
 * The job (every minute): every order that changed lately and may owe the group a message, and every order the group has details of
 * that no longer exists. Catches the paths no route hook covers and any hook that failed.
 */
export async function runOrderGroupPosts(db = pool) {
  const { rows } = await db.query(
    `SELECT o.id FROM orders o
     WHERE o.updated_at > now() - interval '2 days'
       AND (o.status = ANY($1) OR EXISTS (SELECT 1 FROM group_posts g WHERE g.ref_id = o.id))
     UNION
     SELECT g.ref_id FROM group_posts g
     WHERE g.created_at > now() - interval '30 days' AND g.ref_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = g.ref_id)
       AND g.id = (SELECT max(g2.id) FROM group_posts g2 WHERE g2.ref_id = g.ref_id) AND g.kind <> 'order_cancelled'`,
    [DOCUMENT_STATUSES]
  );
  const done = {};
  for (const { id } of rows) {
    const did = await syncOrderPost(id, {}, db);
    if (did) done[did] = (done[did] ?? 0) + 1;
  }
  return done;
}

// ---- the bot's side (erpSync routes) ----
/** What waits, oldest first. Taking a message marks it claimed, so it is no longer corrected in place; unreported, it is offered again. */
export async function claimGroupPosts(db = pool) {
  const { rows } = await db.query(
    `UPDATE group_posts SET claimed_at = now()
     WHERE id IN (SELECT id FROM group_posts
                  WHERE posted_at IS NULL AND post_attempts < 10 AND created_at > now() - make_interval(days => $2)
                    AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1))
                  ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING id, kind, text`,
    [CLAIM_MINUTES, OFFER_DAYS]
  );
  return rows.sort((a, b) => a.id - b.id);
}

export async function markGroupPost(id, ok, error = null, db = pool) {
  const { rows } = await db.query(
    ok
      ? "UPDATE group_posts SET posted_at = COALESCE(posted_at, now()), post_attempts = post_attempts + 1, last_post_error = NULL WHERE id = $1 RETURNING id"
      : "UPDATE group_posts SET post_attempts = post_attempts + 1, last_post_error = $2 WHERE id = $1 RETURNING id",
    ok ? [id] : [id, String(error ?? "").slice(0, 300) || "failed"]
  );
  return Boolean(rows[0]);
}
