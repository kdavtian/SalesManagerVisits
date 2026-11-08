// The Requests screen and the request card (owner, 2026-11-08). Read-only: the card's Approve / Deny call each kind's OWN endpoint
// (same server checks, one place for each decision); this router only lists what waits for the person and shows one request.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { seesProductCosts } from "../../shared/roles.js";
import { decidableRequests, isRequestKind, mayDecide, mayView } from "../requests/rules.js";
import { loadRequest } from "../requests/queries.js";

export const requestsRouter = Router();
requestsRouter.use(requireAuth);

// Everything waiting that this person may decide, newest first.
requestsRouter.get("/", async (req, res) => {
  const items = await decidableRequests(pool, req.user);
  res.json({ items: items.map(({ facts, ...rest }) => rest), total: items.length });
});

requestsRouter.get("/:kind/:id", async (req, res) => {
  const { kind } = req.params;
  if (!isRequestKind(kind)) return res.status(404).json({ error: "Not found" });
  const request = await loadRequest(pool, kind, Number(req.params.id));
  if (!request) return res.status(404).json({ error: "Not found" });
  if (!mayView(kind, req.user, request)) return res.status(403).json({ error: "Not allowed" });
  const { facts, ...out } = request;
  out.can_decide = out.status === "pending" && mayDecide(kind, req.user, facts);
  // margins and cost floors are for the people who see product costs (same rule as GET /api/orders/:id)
  if (kind === "discount" && !seesProductCosts(req.user.role)) {
    out.details = { ...out.details, margin_pct: null, below_cost: false, below_landing: false, lines: out.details.lines.map((l) => ({ ...l, below_landing: false })) };
  }
  res.json(out);
});
