import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { haversineMeters } from "../utils/geo.js";
import { normalizeCustomerName, DUPLICATE_CUSTOMER_RADIUS_METERS } from "./customers.js";

export const dataQualityRouter = Router();

// Admin-only: this is a cleanup/oversight tool, not something a rep needs
// day to day, and it surfaces every customer's owner/channel gaps
// company-wide regardless of who's assigned to them.
dataQualityRouter.use(requireAuth, requireAdmin);

// A customer missing an owner or sales channel is invisible to some of the
// app's own filtering/visibility logic (a sales_manager only ever sees
// customers assigned to them, and several reports group by channel) --
// these aren't hard failures anywhere, just silent gaps that leave a
// customer stuck in nobody's queue. lat/lng can never actually be NULL
// (NOT NULL + Armenia-bounds validation on every write, see customers.js),
// but (0, 0) is checked anyway as defense-in-depth against a row that
// somehow bypassed that, or a future bulk-import path that might not.
dataQualityRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.lat, c.lng, c.assigned_manager_id, c.sales_channel, c.erp_customer_id,
            am.name AS assigned_manager_name
     FROM customers c
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     ORDER BY c.name`
  );

  const flaggedCustomers = [];
  for (const c of rows) {
    const flags = [];
    if (!c.assigned_manager_id) flags.push("no_owner");
    if (!c.sales_channel) flags.push("no_channel");
    if (c.lat == null || c.lng == null || (c.lat === 0 && c.lng === 0)) flags.push("no_location");
    if (flags.length) {
      flaggedCustomers.push({
        id: c.id,
        name: c.name,
        erp_customer_id: c.erp_customer_id,
        assigned_manager_name: c.assigned_manager_name,
        flags,
      });
    }
  }

  // Same-name-within-a-tight-radius scan across the WHOLE table, not just
  // at write time -- catches duplicates that predate this check (or were
  // created with confirm_duplicate: true and turned out to actually be a
  // mistake). Grouping by normalized name first keeps this well under
  // O(n^2) over the full table; only same-name candidates are ever
  // distance-compared against each other.
  const byName = new Map();
  for (const c of rows) {
    const key = normalizeCustomerName(c.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  const duplicateGroups = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const matchedIds = new Set();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (haversineMeters(group[i].lat, group[i].lng, group[j].lat, group[j].lng) <= DUPLICATE_CUSTOMER_RADIUS_METERS) {
          matchedIds.add(group[i].id);
          matchedIds.add(group[j].id);
        }
      }
    }
    if (matchedIds.size) {
      duplicateGroups.push({
        name: group[0].name,
        customers: group.filter((c) => matchedIds.has(c.id)).map((c) => ({ id: c.id, lat: c.lat, lng: c.lng })),
      });
    }
  }

  res.json({
    counts: {
      no_owner: flaggedCustomers.filter((f) => f.flags.includes("no_owner")).length,
      no_channel: flaggedCustomers.filter((f) => f.flags.includes("no_channel")).length,
      no_location: flaggedCustomers.filter((f) => f.flags.includes("no_location")).length,
      duplicate_groups: duplicateGroups.length,
    },
    flagged_customers: flaggedCustomers,
    duplicate_groups: duplicateGroups,
  });
});
