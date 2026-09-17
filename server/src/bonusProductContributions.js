// Tracks product-sales challenge contributions (bonus_product_challenge_
// contributions -- migrations/076_bonuses_schema.sql) from real order
// lines. Recomputed per active product_sales round on every worker tick
// rather than event-driven off order creation, so an edited/split order
// line's "current net contribution" (per the brief) is always exactly
// today's order_items state -- no separate edit-tracking logic needed, the
// next tick just overwrites net_pieces with whatever quantity is there now.
import { pool } from "./db/pool.js";

// Matches an order_item to one of the round's product targets: by
// product_id when the target has one (the common case), falling back to an
// exact product_name_snapshot match for a target whose original product
// was later deleted (product_id ON DELETE SET NULL) -- the snapshot name is
// exactly what the migration comment says it's for.
function matchTarget(item, productTargets) {
  return productTargets.find((t) => (t.product_id != null && t.product_id === item.product_id) || t.product_name_snapshot === item.product_name);
}

export async function syncProductSalesContributions(round) {
  const participantIds = (await pool.query("SELECT user_id FROM bonus_round_participants WHERE round_id = $1", [round.id])).rows.map(
    (r) => r.user_id
  );
  if (!participantIds.length) return { synced: 0 };
  const productTargets = round.snapshot_rules.productTargets;
  if (!productTargets?.length) return { synced: 0 };

  const { rows: items } = await pool.query(
    `SELECT oi.id AS order_item_id, oi.order_id, oi.product_id, oi.product_name, oi.quantity, o.user_id, o.created_at
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.user_id = ANY($1) AND o.status <> 'draft' AND o.status <> 'cancelled'
       AND o.created_at >= $2 AND o.created_at < $3`,
    [participantIds, round.start_at, round.end_at]
  );

  let synced = 0;
  for (const item of items) {
    const target = matchTarget(item, productTargets);
    if (!target) continue;
    await pool.query(
      `INSERT INTO bonus_product_challenge_contributions (round_id, user_id, product_target_id, order_id, order_item_id, net_pieces, occurrence_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (round_id, order_item_id) DO UPDATE SET net_pieces = EXCLUDED.net_pieces, updated_at = now()`,
      [round.id, item.user_id, target.id, item.order_id, item.order_item_id, Math.trunc(item.quantity), item.created_at]
    );
    synced += 1;
  }
  return { synced };
}
