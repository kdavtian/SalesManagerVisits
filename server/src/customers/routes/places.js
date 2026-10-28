// Armenian places: autocomplete for the region / subregion fields, and the review list for what the autocorrect could not place (owner, 2026-10-25).
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { searchPlaces, resolvePlaces, addCustomPlaceInMemory, loadCustomPlaces } from "../places.js";
import { PLACE_REVIEW_ROLES } from "../placeReviews.js";

export const placesRouter = Router();
placesRouter.use(requireAuth);

const blank = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
const reviewOnly = (req, res, next) => (PLACE_REVIEW_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));

placesRouter.get("/search", (req, res) => {
  res.json(searchPlaces(req.query.q, { region: blank(req.query.region) ?? undefined }));
});

// What would be saved for this text -- the forms show it before saving.
placesRouter.post("/resolve", (req, res) => {
  const r = resolvePlaces({ region: blank(req.body?.region), subregion: blank(req.body?.subregion) });
  res.json({ region: r.region, subregion: r.subregion, changed: r.changed, unknown: r.unknown });
});

placesRouter.get("/reviews", reviewOnly, async (req, res) => {
  const status = req.query.status === "resolved" ? "resolved" : "pending";
  const { rows } = await pool.query(
    `SELECT pr.id, pr.customer_id, pr.field, pr.typed_value, pr.applied_value, pr.kind, pr.suggestions, pr.status, pr.resolution, pr.created_at,
            c.name AS customer_name, c.region AS customer_region, c.subregion AS customer_subregion, u.name AS created_by_name
     FROM place_reviews pr
     JOIN customers c ON c.id = pr.customer_id
     LEFT JOIN users u ON u.id = pr.created_by
     WHERE pr.status = $1
     ORDER BY pr.created_at DESC
     LIMIT 200`,
    [status]
  );
  res.json(rows);
});

placesRouter.get("/reviews/count", reviewOnly, async (_req, res) => {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM place_reviews WHERE status = 'pending'");
  res.json({ pending: rows[0].n });
});

// accept: use the suggestion (or the chosen name) on the customer; keep: the typed name is right (added to the places, with an Armenian spelling if given);
// dismiss: nothing to do.
placesRouter.post("/reviews/:id/resolve", reviewOnly, async (req, res) => {
  const { action, value, name_hy } = req.body ?? {};
  if (!["accept", "keep", "dismiss"].includes(action)) return res.status(400).json({ error: "action must be accept, keep or dismiss" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT pr.*, c.region AS c_region, c.subregion AS c_subregion FROM place_reviews pr JOIN customers c ON c.id = pr.customer_id
       WHERE pr.id = $1 AND pr.status = 'pending' FOR UPDATE OF pr`,
      [req.params.id]
    );
    const review = rows[0];
    if (!review) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Review not found or already closed" });
    }
    let resolution = action === "accept" ? "accepted" : action === "keep" ? "kept" : "dismissed";
    if (action === "accept") {
      const chosen = (blank(value) && review.suggestions.find((s) => s.en === value)) || review.suggestions[0];
      const name = blank(value) && !chosen ? blank(value) : chosen?.en;
      if (!name) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No suggestion to accept; choose a name or keep the typed text" });
      }
      await client.query(`UPDATE customers SET ${review.field} = $1 WHERE id = $2`, [name, review.customer_id]);
      // a place of another marz: move the customer's marz with it
      if (review.field === "subregion" && chosen?.region && chosen.region !== review.c_region) {
        await client.query("UPDATE customers SET region = $1 WHERE id = $2", [chosen.region, review.customer_id]);
      }
    } else if (action === "keep") {
      const typed = review.field === "subregion" ? review.applied_value : review.applied_value;
      const region = review.field === "subregion" ? review.c_region : null;
      await client.query(
        `INSERT INTO custom_places (name_en, name_hy, region, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (lower(name_en), COALESCE(region, '')) DO UPDATE SET name_hy = COALESCE(EXCLUDED.name_hy, custom_places.name_hy)`,
        [typed, blank(name_hy), region, req.user.id]
      );
      addCustomPlaceInMemory({ name_en: typed, name_hy: blank(name_hy), region });
    }
    await client.query(
      "UPDATE place_reviews SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1",
      [review.id, resolution, req.user.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, resolution });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

// ---- cleanup of the spellings already in the customer list -----------------------------------------------------------------------------------

async function planCleanup() {
  const { rows } = await pool.query(
    "SELECT region, subregion, COUNT(*)::int AS customers FROM customers WHERE region IS NOT NULL OR subregion IS NOT NULL GROUP BY region, subregion ORDER BY region, subregion"
  );
  const changes = [];
  const unplaced = [];
  for (const row of rows) {
    const r = resolvePlaces({ region: row.region, subregion: row.subregion });
    const to = { region: blank(r.region), subregion: blank(r.subregion) };
    if (to.region !== blank(row.region) || to.subregion !== blank(row.subregion)) {
      changes.push({ from: { region: row.region, subregion: row.subregion }, to, customers: row.customers });
    }
    if (r.unknown.length) unplaced.push({ region: to.region, subregion: to.subregion, customers: row.customers, fields: r.unknown.map((u) => u.field) });
  }
  return { changes, unplaced };
}

placesRouter.get("/cleanup", reviewOnly, async (_req, res) => res.json(await planCleanup()));

// Rewrites the old spellings in the customers and in everything that stores the same text (route distribution, visit plan areas), in one transaction.
placesRouter.post("/cleanup/apply", reviewOnly, async (_req, res) => {
  const plan = await planCleanup();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let customers = 0;
    for (const ch of plan.changes) {
      const { rowCount } = await client.query(
        `UPDATE customers SET region = $3, subregion = $4
         WHERE region IS NOT DISTINCT FROM $1 AND subregion IS NOT DISTINCT FROM $2`,
        [ch.from.region, ch.from.subregion, ch.to.region, ch.to.subregion]
      );
      customers += rowCount;
      await client.query(
        `UPDATE route_distribution rd SET region = $3, subregion = $4
         WHERE rd.region IS NOT DISTINCT FROM $1 AND rd.subregion IS NOT DISTINCT FROM $2
           AND NOT EXISTS (SELECT 1 FROM route_distribution o WHERE o.region IS NOT DISTINCT FROM $3 AND COALESCE(o.subregion, '') = COALESCE($4::text, '') AND o.id <> rd.id)`,
        [ch.from.region, ch.from.subregion, ch.to.region, ch.to.subregion]
      );
    }
    // visit plan rules keep their areas as [{region, subregion}] text
    const { rows: rules } = await client.query("SELECT id, areas FROM visit_plan_rules WHERE jsonb_array_length(areas) > 0");
    for (const rule of rules) {
      let touched = false;
      const areas = rule.areas.map((a) => {
        const hit = plan.changes.find((ch) => blank(ch.from.region) === blank(a.region) && blank(ch.from.subregion) === blank(a.subregion));
        if (!hit) return a;
        touched = true;
        return { ...a, region: hit.to.region, subregion: hit.to.subregion ?? undefined };
      });
      if (touched) await client.query("UPDATE visit_plan_rules SET areas = $1 WHERE id = $2", [JSON.stringify(areas), rule.id]);
    }
    // what is still not a known place goes to the review list, one row per customer
    let queued = 0;
    for (const u of plan.unplaced) {
      for (const field of u.fields) {
        const typed = field === "region" ? u.region : u.subregion;
        if (!typed) continue;
        const { rowCount } = await client.query(
          `INSERT INTO place_reviews (customer_id, field, typed_value, applied_value, kind, suggestions, created_by)
           SELECT c.id, $3, $4, $4, 'unknown', '[]'::jsonb, NULL FROM customers c
           WHERE c.region IS NOT DISTINCT FROM $1 AND c.subregion IS NOT DISTINCT FROM $2
           ON CONFLICT (customer_id, field) WHERE status = 'pending' DO NOTHING`,
          [u.region, u.subregion, field, typed]
        );
        queued += rowCount;
      }
    }
    await client.query("COMMIT");
    await loadCustomPlaces();
    res.json({ ok: true, customers, queued, changes: plan.changes.length });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});
