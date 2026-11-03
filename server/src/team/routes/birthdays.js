// "Birthday today" on Home for everybody, and the one-tap congratulation (owner, 2026-11-03). Names only, never an age or a date of birth.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { birthdaysOn, addWish } from "../birthdays.js";

export const birthdaysRouter = Router();
birthdaysRouter.use(requireAuth);

birthdaysRouter.get("/today", async (req, res) => {
  const day = yerevanToday();
  const list = await birthdaysOn(day);
  if (!list.length) return res.json({ day, people: [] });
  const year = Number(day.slice(0, 4));
  const { rows } = await pool.query("SELECT staff_id FROM staff_birthday_wishes WHERE year = $1 AND from_user_id = $2 AND staff_id = ANY($3)", [year, req.user.id, list.map((p) => p.staff_id)]);
  const wished = new Set(rows.map((r) => r.staff_id));
  res.json({
    day,
    people: list.map((p) => ({ staff_id: p.staff_id, name: p.user_name || p.name, name_hy: p.user_name_hy || null, is_me: p.user_id === req.user.id, wished: wished.has(p.staff_id) })),
  });
});

birthdaysRouter.post("/:staffId/wish", async (req, res) => {
  const staffId = Number(req.params.staffId);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: "Invalid person" });
  const day = yerevanToday();
  const person = (await birthdaysOn(day)).find((p) => p.staff_id === staffId);
  if (!person) return res.status(409).json({ error: "Not this person's birthday today" });
  if (person.user_id === req.user.id) return res.status(409).json({ error: "You cannot congratulate yourself" });
  await addWish(staffId, Number(day.slice(0, 4)), req.user.id);
  res.json({ ok: true });
});
