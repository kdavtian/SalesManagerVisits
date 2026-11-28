// "Is this packed order waiting to be put on a route?" -- one rule for the planner list, the route builder and every counter.
// Only an OPEN stop (completed_at IS NULL) holds an order. A failed delivery closes its stop but leaves the order
// packed_stock_out (delivery.js /fail), so it must come back to the planner; a delivered order is no longer packed.
// Expects the orders table aliased as `o`.
// A failed order planned again the same day has two stops that day: lists and counts of a day show only its latest one (the open attempt).
// Expects route_stops aliased as `rs` and delivery_routes as `r`.
export const LATEST_STOP_OF_DAY_SQL =
  "NOT EXISTS (SELECT 1 FROM route_stops rs2 JOIN delivery_routes r2 ON r2.id = rs2.route_id WHERE rs2.order_id = rs.order_id AND r2.route_date = r.route_date AND rs2.id > rs.id)";
export const NOT_ON_OPEN_ROUTE_SQL = "NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.completed_at IS NULL)";
