// /api/purchase-receiving -- Purchases P5 (owner, 2026-11-20): the purchases on their way and the count of what came. The warehouse manager
// and the purchases managers (canReceivePurchases). Quantities only: no price, rate or amount leaves this router (the warehouse works with
// pieces, not money; shared/roles.js).
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canReceivePurchases } from "../../shared/roles.js";
import { incomingPurchases, receivePurchase, PurchaseError } from "../purchases.js";

export const purchaseReceivingRouter = Router();
purchaseReceivingRouter.use(requireAuth);
purchaseReceivingRouter.use((req, res, next) => (canReceivePurchases(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

purchaseReceivingRouter.get("/", async (_req, res) => {
  res.json({ purchases: await incomingPurchases() });
});

purchaseReceivingRouter.post("/:id/receive", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) return res.status(404).json({ error: "Purchase not found" });
  try {
    const result = await receivePurchase(id, req.body, req.user);
    const one = (await incomingPurchases()).find((p) => p.id === id) ?? null;
    res.json({ ...result, purchase: one });
  } catch (err) {
    if (err instanceof PurchaseError) return res.status(err.message === "Purchase not found" ? 404 : err.code === "received" ? 409 : 400).json({ error: err.message });
    throw err;
  }
});
