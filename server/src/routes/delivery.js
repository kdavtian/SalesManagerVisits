// Route Planner + Driver delivery screens. Distinct from the existing SM
// "Plan day" visit-plan tool (visit_plans table, in routes/visitPlans.js) --
// that plans customer *visits*; this plans *deliveries* of packed orders,
// using the self-hosted OSRM engine (server/src/osrm.js) with a
// straight-line fallback. See migrations/050_warehouse_delivery.sql.
import path from "node:path";
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canPlanRoutes, canDeliverOrders, seesUnrecordedBadge, canSubmitPaymentsForOthers } from "../roles.js";
import { notifyUser } from "../notifications.js";
import { DRIVER_NOTIFY_ROLES, DELIVERY_OUTCOME_NOTIFY_ROLES } from "../notificationPreferences.js";
import { buildMatrix, optimizeOrder } from "../osrm.js";
import { signatureUpload, uploadDirPath } from "../upload.js";
import { insertPayment } from "./payments.js";

export const deliveryRouter = Router();
deliveryRouter.use(requireAuth);

// Every packed_stock_out order not already on an active route -- what the
// planner auto-pools stops from (spec: the planner gathers these itself,
// no manual checkbox selection).
deliveryRouter.get("/packed-orders", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.id, o.order_code, o.total_amd, c.name AS customer_name, c.address, c.lat, c.lng
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'packed_stock_out'
       AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id)
     ORDER BY o.created_at ASC`
  );
  res.json(rows);
});

// Backs the badge on the Home tab's Delivery icon -- how much unfinished
// delivery work is sitting there: packed orders nobody's routed yet
// (needs planning) plus stops on a route that haven't been delivered yet
// (needs driving). Not split by driver -- same shared-queue model as
// warehouse's own badge, since canPlanRoutes/canDeliverOrders are
// currently the same role gate (see roles.js).
deliveryRouter.get("/pending-count", async (req, res) => {
  if (!canPlanRoutes(req.user.role) && !canDeliverOrders(req.user.role)) return res.json({ count: 0 });
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM orders o WHERE o.status = 'packed_stock_out'
          AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id))
       + (SELECT COUNT(*)::int FROM route_stops WHERE completed_at IS NULL)
       AS count`
  );
  res.json({ count: rows[0].count });
});

// Every route stop still open (completed_at IS NULL), across every driver
// and date -- exactly what the "pending-count" badge above sums the second
// half of. The planner previously had no way to see this half at all: once
// an order is routed it drops out of /packed-orders (NOT EXISTS route_stops
// filters it out), so a stop stuck open on some driver's route (planned for
// a date they never opened the app on, or a route nobody's actively
// driving) was invisible everywhere except as an unexplained badge count.
deliveryRouter.get("/active-stops", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT rs.id, rs.route_id, rs.sequence, r.route_date::text AS route_date, r.driver_id, u.name AS driver_name,
            o.id AS order_id, o.order_code, o.status AS order_status, o.total_amd,
            c.id AS customer_id, c.name AS customer_name, c.address
     FROM route_stops rs
     JOIN delivery_routes r ON r.id = rs.route_id
     JOIN users u ON u.id = r.driver_id
     JOIN orders o ON o.id = rs.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE rs.completed_at IS NULL
     ORDER BY r.route_date ASC, u.name ASC, rs.sequence ASC`
  );
  res.json(rows);
});

// Releases a stuck-open stop back into the unrouted pool -- the planner's
// escape hatch for exactly what /active-stops above makes visible: a route
// nobody's actively driving (the driver never opened the app for that date,
// the route was planned by mistake, etc). Just removes the route_stops row;
// the order's own status is untouched (still packed_stock_out), so it falls
// straight back into /packed-orders and can be replanned onto a fresh route
// the normal way. Deliberately not a delivery outcome (no fail/complete
// semantics) -- this is "this route assignment was wrong", not "this
// delivery happened or didn't".
deliveryRouter.delete("/routes/:routeId/stops/:orderId", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rowCount } = await pool.query(
    "DELETE FROM route_stops WHERE route_id = $1 AND order_id = $2 AND completed_at IS NULL",
    [req.params.routeId, req.params.orderId]
  );
  if (!rowCount) return res.status(404).json({ error: "Open stop not found" });
  res.status(204).end();
});

deliveryRouter.get("/drivers", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query("SELECT id, name FROM users WHERE role = 'delivery_manager' ORDER BY name");
  res.json(rows);
});

async function loadRoute(routeId) {
  const { rows: routeRows } = await pool.query(
    `SELECT r.*, u.name AS driver_name FROM delivery_routes r JOIN users u ON u.id = r.driver_id WHERE r.id = $1`,
    [routeId]
  );
  const route = routeRows[0];
  if (!route) return null;
  const { rows: stops } = await pool.query(
    `SELECT rs.*, o.order_code, o.total_amd, o.status AS order_status, c.name AS customer_name, c.address, c.lat, c.lng, c.erp_customer_id
     FROM route_stops rs
     JOIN orders o ON o.id = rs.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE rs.route_id = $1
     ORDER BY rs.sequence ASC`,
    [routeId]
  );
  return { ...route, stops };
}

// Builds (or refreshes) a driver's route for a day from every
// packed_stock_out order not already on a route -- the planner auto-pools
// stops itself (spec: no manual checkbox selection). Runs
// nearest-neighbor + 2-opt against OSRM (or the haversine fallback)
// starting from the driver's given location. Order status is left at
// "packed_stock_out" -- v3 has no separate "out for delivery" state, so
// routing doesn't move the order forward, only delivery confirmation does.
deliveryRouter.post("/routes/plan", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { driver_id, route_date, start_lat, start_lng } = req.body ?? {};
  const driverId = Number(driver_id);
  const routeDate = route_date || new Date().toISOString().slice(0, 10);
  if (!driverId) return res.status(400).json({ error: "driver_id is required" });
  const { rows: driverRows } = await pool.query("SELECT id, role FROM users WHERE id = $1", [driverId]);
  if (!driverRows[0] || !canDeliverOrders(driverRows[0].role)) {
    return res.status(400).json({ error: "driver_id must be a delivery_manager" });
  }

  const { rows: orders } = await pool.query(
    `SELECT o.id, o.status, c.name AS customer_name, c.lat, c.lng
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'packed_stock_out'
       AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id)
       AND c.lat IS NOT NULL AND c.lng IS NOT NULL
     ORDER BY o.created_at ASC`
  );
  if (!orders.length) return res.status(409).json({ error: "No packed orders with a map location are waiting to be routed" });

  // Point 0 is the driver's starting location (defaults to the first
  // stop's location if not given, so the optimizer still has something to
  // anchor from).
  const startPoint =
    start_lat != null && start_lng != null ? { lat: Number(start_lat), lng: Number(start_lng) } : { lat: orders[0].lat, lng: orders[0].lng };
  const points = [startPoint, ...orders.map((o) => ({ lat: o.lat, lng: o.lng }))];
  const { distances, durations, usedOsrm } = await buildMatrix(points);
  const visitOrder = optimizeOrder(distances); // indices into `points`, index 0 is the depot

  const client = await pool.connect();
  let routeId;
  try {
    await client.query("BEGIN");
    const { rows: routeRows } = await client.query(
      `INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [driverId, routeDate, req.user.id]
    );
    routeId = routeRows[0].id;

    // visitOrder[0] is always the depot (index 0) -- everything after it is
    // the stop sequence.
    const stopIndices = visitOrder.filter((i) => i !== 0);
    let sequence = 1;
    let prevPointIndex = visitOrder[0];
    for (const pointIndex of stopIndices) {
      const order = orders[pointIndex - 1]; // points[0] is the depot, so orders[pointIndex - 1]
      await client.query(
        `INSERT INTO route_stops (route_id, order_id, sequence, leg_distance_meters, leg_duration_seconds)
         VALUES ($1, $2, $3, $4, $5)`,
        [routeId, order.id, sequence, distances[prevPointIndex][pointIndex], durations[prevPointIndex][pointIndex]]
      );
      prevPointIndex = pointIndex;
      sequence++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const route = await loadRoute(routeId);
  res.status(201).json({ ...route, used_osrm: usedOsrm });

  (async () => {
    try {
      for (const recipient of await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DRIVER_NOTIFY_ROLES]).then((r) => r.rows)) {
        if (recipient.id === driverId) continue;
        notifyUser(recipient.id, "order_packed", {
          title: "Delivery route planned",
          body: `A route with ${orders.length} stop${orders.length === 1 ? "" : "s"} was planned for today.`,
          url: "/#/delivery",
        });
      }
      notifyUser(driverId, "order_packed", {
        title: "New delivery route",
        body: `You have ${orders.length} stop${orders.length === 1 ? "" : "s"} on today's route.`,
        url: "/#/delivery",
      });
    } catch (err) {
      console.error("Post-route-plan notification failed:", err);
    }
  })();
});

deliveryRouter.get("/routes/:id", async (req, res) => {
  const route = await loadRoute(req.params.id);
  if (!route) return res.status(404).json({ error: "Route not found" });
  if (!canPlanRoutes(req.user.role) && route.driver_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }
  res.json(route);
});

// A driver's own route for a given day (defaults to today) -- what the
// mobile delivery screen loads.
deliveryRouter.get("/my-route", async (req, res) => {
  if (!canDeliverOrders(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const routeDate = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    "SELECT id FROM delivery_routes WHERE driver_id = $1 AND route_date = $2 ORDER BY created_at DESC LIMIT 1",
    [req.user.id, routeDate]
  );
  if (!rows[0]) return res.json(null);
  res.json(await loadRoute(rows[0].id));
});

// Manual drag-reorder of an existing route's stops -- send the full
// order_ids array in the new sequence.
deliveryRouter.post("/routes/:id/reorder", async (req, res) => {
  if (!canPlanRoutes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { order_ids } = req.body ?? {};
  if (!Array.isArray(order_ids) || !order_ids.length) {
    return res.status(400).json({ error: "order_ids is required" });
  }
  const route = await loadRoute(req.params.id);
  if (!route) return res.status(404).json({ error: "Route not found" });
  const currentIds = new Set(route.stops.map((s) => s.order_id));
  if (order_ids.length !== currentIds.size || !order_ids.every((id) => currentIds.has(Number(id)))) {
    return res.status(400).json({ error: "order_ids must match this route's existing stops exactly" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < order_ids.length; i++) {
      await client.query("UPDATE route_stops SET sequence = $1 WHERE route_id = $2 AND order_id = $3", [
        i + 1,
        req.params.id,
        Number(order_ids[i]),
      ]);
    }
    await client.query("UPDATE delivery_routes SET updated_at = now() WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  res.json(await loadRoute(req.params.id));
});

// The debt & payment panel on the driver's per-stop screen: ERP-synced
// debt (as of last sync), this order's amount, and what the resulting
// balance would be with no payment collected yet -- refreshed live as the
// driver types an amount client-side, this endpoint just supplies the
// starting numbers.
deliveryRouter.get("/orders/:id/debt-snapshot", async (req, res) => {
  if (!canDeliverOrders(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.id, o.total_amd, o.status, c.erp_customer_id, erp.debt_amd
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Order not found" });
  res.json({
    order_amount_amd: Number(row.total_amd),
    debt_before_amd: row.debt_amd != null ? Number(row.debt_amd) : null,
  });
});

// Confirms a delivery: saves the signature as Proof of Delivery, records
// the amount/method collected as informational fields on the POD record
// (no payment-approval workflow here -- Excel remains the source of truth
// for collections, per spec section 9), and moves the order to delivered.
deliveryRouter.post("/orders/:id/confirm", (req, res, next) => {
  signatureUpload.single("signature")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!canDeliverOrders(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  if (!req.file) return res.status(400).json({ error: "A signature image is required" });

  const { rows: driverRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
  const driverName = driverRows[0]?.name || "Driver";

  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.erp_customer_id
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "packed_stock_out") {
    return res.status(409).json({ error: `Cannot confirm delivery for an order that is "${order.status}"` });
  }

  const amountCollected = Number(req.body.amount_collected_amd) || 0;
  const paymentMethod = amountCollected > 0 && ["cash", "other"].includes(req.body.payment_method) ? req.body.payment_method : null;
  const { rows: erpRows } = await pool.query("SELECT debt_amd FROM erp_customer_data WHERE erp_customer_id = $1", [
    order.erp_customer_id,
  ]);
  const debtBefore = erpRows[0]?.debt_amd != null ? Number(erpRows[0].debt_amd) : null;
  const newBalance = debtBefore != null ? debtBefore + Number(order.total_amd) - amountCollected : null;
  const signaturePath = path.join("signatures", req.file.filename);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO pod_records
         (order_id, driver_id, driver_name_snapshot, signature_path, debt_balance_before_amd, order_amount_amd, amount_collected_amd, new_balance_after_amd, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [order.id, req.user.id, driverName, signaturePath, debtBefore, order.total_amd, amountCollected, newBalance, paymentMethod]
    );
    await client.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1", [order.id]);
    await client.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1", [order.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const updatedOrder = { ...order, status: "delivered" };
  res.json(updatedOrder);

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DELIVERY_OUTCOME_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "order_delivered", {
          title: "Order delivered",
          body: `${order.customer_name}'s order was delivered.`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-delivery notification failed:", err);
    }
  })();
});

// Delivery failed -- no reason required, no stock adjustment (per spec).
// Drops the order back to "draft" (the shared exception loop -- see
// migrations/051_warehouse_delivery_v3.sql) for the rep/director to fix up
// and resubmit.
deliveryRouter.post("/orders/:id/fail", async (req, res) => {
  if (!canDeliverOrders(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "packed_stock_out") {
    return res.status(409).json({ error: `Cannot fail delivery for an order that is "${order.status}"` });
  }

  await pool.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1", [order.id]);
  const { rows: updatedRows } = await pool.query(
    "UPDATE orders SET status = 'draft', draft_reason = 'Delivery attempt failed', updated_at = now() WHERE id = $1 RETURNING *",
    [order.id]
  );
  res.json(updatedRows[0]);

  (async () => {
    try {
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DELIVERY_OUTCOME_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        notifyUser(recipient.id, "order_returned", {
          title: "Delivery failed",
          body: `${order.customer_name}'s delivery attempt failed and was returned to draft.`,
          url: "/#/orders",
        });
      }
    } catch (err) {
      console.error("Post-return notification failed:", err);
    }
  })();
});

// Accountant's "Create payment record" action on the Recorded screen
// (v3 spec section 6): turns a POD's informational amount_collected_amd
// into a real, reviewable row in the Payments approval table -- mirrors
// checkins.js's "payment collected" outcome, except the money here was
// collected by the driver at delivery, not by a rep during a visit, so
// the sales manager credited is the customer's *owner*
// (customers.assigned_manager_id), not whoever is clicking this button.
// Gated the same as manual payment creation (canSubmitPaymentsForOthers);
// that role set is already a superset of who sees this screen at all
// (seesUnrecordedBadge), so a single check is enough -- nobody who can see
// this screen but not create payments can reach this endpoint.
deliveryRouter.post("/pod-records/:id/create-payment", async (req, res) => {
  if (!canSubmitPaymentsForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });

  const { rows } = await pool.query(
    `SELECT pod.*, c.id AS customer_id, c.name AS customer_name, c.erp_customer_id, c.assigned_manager_id
     FROM pod_records pod
     JOIN orders o ON o.id = pod.order_id
     JOIN customers c ON c.id = o.customer_id
     WHERE pod.id = $1`,
    [req.params.id]
  );
  const pod = rows[0];
  if (!pod) return res.status(404).json({ error: "POD record not found" });

  const amount = Number(pod.amount_collected_amd);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(409).json({ error: "Nothing was collected on this delivery -- there is nothing to create a payment record for" });
  }
  if (pod.payment_id) {
    return res.status(409).json({ error: "Payment already created for this delivery" });
  }
  if (!pod.assigned_manager_id) {
    return res.status(409).json({ error: "This customer has no assigned sales manager to credit the payment to" });
  }

  const { rows: managerRows } = await pool.query("SELECT id, name, position, role FROM users WHERE id = $1", [pod.assigned_manager_id]);
  const manager = managerRows[0];
  if (!manager) return res.status(409).json({ error: "Assigned sales manager not found" });

  const customer = { id: pod.customer_id, name: pod.customer_name, erp_customer_id: pod.erp_customer_id };
  const note = pod.payment_method ? `Delivery collection (${pod.payment_method})` : "Delivery collection";

  const client = await pool.connect();
  let paymentId;
  try {
    await client.query("BEGIN");
    // Passing this transaction's own client into insertPayment (db: client)
    // is what makes the insert and the pod_records.payment_id UPDATE below
    // commit or roll back together -- a failure between the two can't leave
    // an orphaned, un-linked payment that would let someone create a SECOND
    // payment for the same delivery.
    paymentId = await insertPayment({
      customer,
      amount,
      paymentDate: pod.delivered_at,
      salesManagerId: pod.assigned_manager_id,
      manager,
      note,
      createdBy: req.user.id,
      clientRef: `pod-${pod.id}`,
      db: client,
    });
    if (!paymentId) throw new Error("Payment creation returned no id");
    await client.query("UPDATE pod_records SET payment_id = $1 WHERE id = $2", [paymentId, pod.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ payment_id: paymentId });
});

// Serves a POD signature image -- gated the same way checkin photos are:
// fulfillment/management roles, or the driver who captured it.
deliveryRouter.get("/pod/:orderId/signature", async (req, res) => {
  const { rows } = await pool.query("SELECT signature_path, driver_id FROM pod_records WHERE order_id = $1 ORDER BY id DESC LIMIT 1", [
    req.params.orderId,
  ]);
  const pod = rows[0];
  if (!pod) return res.status(404).json({ error: "Signature not found" });
  if (!canPlanRoutes(req.user.role) && !canDeliverOrders(req.user.role) && !seesUnrecordedBadge(req.user.role) && pod.driver_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }
  res.sendFile(path.join(uploadDirPath, pod.signature_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Signature not found" });
  });
});
