import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";

export const customerSocialRouter = Router();
customerSocialRouter.use(requireAuth);

function cleanInstagram(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let candidate = raw.replace(/^@/, "");
  try {
    if (/^https?:\/\//i.test(candidate)) {
      const url = new URL(candidate);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) throw new Error("Invalid Instagram URL");
      candidate = url.pathname.split("/").filter(Boolean)[0] || "";
    }
  } catch {
    throw Object.assign(new Error("Enter a valid Instagram username or profile URL"), { status: 400 });
  }
  if (!/^[A-Za-z0-9._]{1,30}$/.test(candidate)) {
    throw Object.assign(new Error("Enter a valid Instagram username"), { status: 400 });
  }
  return candidate;
}

function cleanFacebook(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(raw.replace(/^@/, ""))) {
      throw Object.assign(new Error("Enter a valid Facebook username or profile URL"), { status: 400 });
    }
    return `https://www.facebook.com/${raw.replace(/^@/, "")}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("Enter a valid Facebook profile URL"), { status: 400 });
  }
  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) {
    throw Object.assign(new Error("Facebook profile must use facebook.com"), { status: 400 });
  }
  url.protocol = "https:";
  url.hostname = "www.facebook.com";
  url.hash = "";
  return url.toString().slice(0, 300);
}

async function loadCustomer(id) {
  const { rows } = await pool.query(
    "SELECT id, created_by, assigned_manager_id, instagram_username, facebook_url FROM customers WHERE id = $1",
    [id]
  );
  return rows[0];
}

function canEditSocial(user, customer) {
  return (
    seesAllActivity(user.role) ||
    customer.created_by === user.id ||
    customer.assigned_manager_id === user.id
  );
}

customerSocialRouter.get("/:id", async (req, res) => {
  const customer = await loadCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  res.json({
    instagram_username: customer.instagram_username,
    facebook_url: customer.facebook_url,
    can_edit: canEditSocial(req.user, customer),
  });
});

customerSocialRouter.patch("/:id", async (req, res) => {
  const customer = await loadCustomer(req.params.id);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  if (!canEditSocial(req.user, customer)) {
    return res.status(403).json({ error: "Not allowed to edit this customer's social profiles" });
  }

  let instagramUsername;
  let facebookUrl;
  try {
    instagramUsername = cleanInstagram(req.body?.instagram);
    facebookUrl = cleanFacebook(req.body?.facebook);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const { rows } = await pool.query(
    `UPDATE customers
     SET instagram_username = $1, facebook_url = $2
     WHERE id = $3
     RETURNING instagram_username, facebook_url`,
    [instagramUsername, facebookUrl, req.params.id]
  );
  res.json({ ...rows[0], can_edit: true });
});
