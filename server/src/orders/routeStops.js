// "Is this packed order waiting to be put on a route?" -- one rule for the planner list, the route builder and every counter.
// Only an OPEN stop (completed_at IS NULL) holds an order. A failed delivery closes its stop but leaves the order
// packed_stock_out (delivery.js /fail), so it must come back to the planner; a delivered order is no longer packed.
// Expects the orders table aliased as `o`.
export const NOT_ON_OPEN_ROUTE_SQL = "NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.completed_at IS NULL)";
