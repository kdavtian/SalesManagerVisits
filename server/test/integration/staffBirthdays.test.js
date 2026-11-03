// Owner, 2026-11-03: staff birthdays. A day and month on the staff card, Vaghinak's greeting with the paid-day-off choice, the whole team's
// "Birthday today" with one-tap wishes, and the gift: a paid day off that does not use the allowance.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";
import { birthdayKeys, isRealBirthday, birthdaysOn } from "../../src/team/birthdays.js";
import { birthdayTick, giftChoices } from "../../src/team/vaghinak/birthdays.js";
import { computeMonthPay } from "../../src/money/payroll.js";

const today = yerevanToday();
const [, M, D] = today.split("-").map(Number);
let admin, ceo, rep, colleague, adminCookie, repCookie, colleagueCookie, staffId, mode;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  ceo = await createUser("ceo");
  rep = await createUser("sales_manager");
  colleague = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  colleagueCookie = await loginAs(colleague.email);
  mode = (await pool.query("SELECT value FROM vaghinak_settings WHERE key = 'mode'")).rows[0]?.value;
  await pool.query(`INSERT INTO vaghinak_settings (key, value) VALUES ('mode', '"live"'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '"live"'::jsonb`);
});
test.after(async () => {
  if (mode === undefined) await pool.query("DELETE FROM vaghinak_settings WHERE key = 'mode'");
  else await pool.query("UPDATE vaghinak_settings SET value = $1::jsonb WHERE key = 'mode'", [JSON.stringify(mode)]);
  await pool.query("DELETE FROM vaghinak_messages WHERE user_id = ANY($1)", [[rep.id, colleague.id, admin.id, ceo.id]]);
  await pool.query("DELETE FROM staff_members WHERE user_id = ANY($1) OR name LIKE 'ZZ Birthday%'", [[rep.id, colleague.id]]);
  await cleanupAll();
  await stopTestServer();
});

test("a birthday is a real day and month; 29 Feb is celebrated on 28 Feb in a year without it", () => {
  assert.equal(isRealBirthday(29, 2), true);
  assert.equal(isRealBirthday(31, 4), false);
  assert.equal(isRealBirthday(1, 13), false);
  assert.deepEqual(birthdayKeys("2026-02-28"), [[2, 28], [2, 29]]);
  assert.deepEqual(birthdayKeys("2028-02-28"), [[2, 28]]);
});

test("the staff card takes a day and a month together, nothing else", async () => {
  const bad = await apiRequest("/api/staff/people", { method: "POST", cookie: adminCookie, body: { name: "ZZ Birthday bad", position: "Sales Manager", birth_day: 31, birth_month: 4 } });
  assert.equal(bad.status, 400);
  const half = await apiRequest("/api/staff/people", { method: "POST", cookie: adminCookie, body: { name: "ZZ Birthday half", position: "Sales Manager", birth_day: 5 } });
  assert.equal(half.status, 400);
  const ok = await apiRequest("/api/staff/people", { method: "POST", cookie: adminCookie, body: { name: "ZZ Birthday Rep", position: "Sales Manager", kind: "rep", user_id: rep.id, birth_day: D, birth_month: M } });
  assert.equal(ok.status, 201);
  staffId = ok.data.id ?? ok.data.person?.id;
  assert.ok(staffId);
  const row = (await pool.query("SELECT birth_day, birth_month FROM staff_members WHERE id = $1", [staffId])).rows[0];
  assert.deepEqual(row, { birth_day: D, birth_month: M });
  assert.ok((await birthdaysOn(today)).some((p) => p.staff_id === staffId));
});

test("the team sees who has a birthday today and can congratulate once; nobody congratulates themselves", async () => {
  const list = await apiRequest("/api/birthdays/today", { cookie: colleagueCookie });
  const me = list.data.people.find((p) => p.staff_id === staffId);
  assert.ok(me);
  assert.equal(me.is_me, false);
  assert.equal(me.wished, false);
  assert.equal("birth_year" in me || "age" in me, false);
  const self = await apiRequest(`/api/birthdays/${staffId}/wish`, { method: "POST", cookie: repCookie });
  assert.equal(self.status, 409);
  assert.equal((await apiRequest(`/api/birthdays/${staffId}/wish`, { method: "POST", cookie: colleagueCookie })).status, 200);
  assert.equal((await apiRequest(`/api/birthdays/${staffId}/wish`, { method: "POST", cookie: colleagueCookie })).status, 200); // again: no second wish
  const again = await apiRequest("/api/birthdays/today", { cookie: colleagueCookie });
  assert.equal(again.data.people.find((p) => p.staff_id === staffId).wished, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM staff_birthday_wishes WHERE staff_id = $1", [staffId])).rows[0].n, 1);
});

test("Vaghinak greets on the day with the days to choose, once; the wishes message follows from 16:00", async () => {
  const at = (hh) => new Date(`${today}T${String(hh - 4).padStart(2, "0")}:30:00Z`); // Yerevan = UTC+4
  const first = await birthdayTick(at(10), pool, { delayMaxMs: 0 });
  assert.ok(first.created >= 1);
  const again = await birthdayTick(at(11), pool, { delayMaxMs: 0 });
  assert.equal(again.created, 0);
  const { rows: [m] } = await pool.query("SELECT body, needs_answer, mandatory, choices FROM vaghinak_messages WHERE user_id = $1 AND kind = 'birthday' AND day = $2", [rep.id, today]);
  assert.ok(m.body.includes("ներքևում"));
  assert.equal(m.needs_answer, true);
  assert.equal(m.mandatory, false);
  assert.ok(m.choices.length >= 2 && m.choices.at(-1).key === "none");
  const late = await birthdayTick(at(17), pool, { delayMaxMs: 0 });
  assert.ok(late.created >= 1);
  const { rows: [w] } = await pool.query("SELECT body FROM vaghinak_messages WHERE user_id = $1 AND kind = 'birthday_wishes' AND day = $2", [rep.id, today]);
  assert.ok(w.body.includes(colleague.name_hy || colleague.name));
});

test("picking a day makes it a paid day off that does not use the allowance", async () => {
  const { rows: [m] } = await pool.query("SELECT id, choices FROM vaghinak_messages WHERE user_id = $1 AND kind = 'birthday' AND day = $2", [rep.id, today]);
  const day = m.choices[1].key; // the second offered working day
  const bad = await apiRequest(`/api/vaghinak/messages/${m.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: "2020-01-01" } });
  assert.equal(bad.status, 400);
  const ok = await apiRequest(`/api/vaghinak/messages/${m.id}/answer`, { method: "POST", cookie: repCookie, body: { choice: day } });
  assert.equal(ok.status, 200);
  const marked = (await pool.query("SELECT status FROM staff_days WHERE staff_id = $1 AND day = $2", [staffId, day])).rows[0];
  assert.equal(marked.status, "birthday_off");
  // offered days no longer include the one taken
  assert.ok(!(await giftChoices(pool, staffId, today)).some((c) => c.key === day));
});

test("payroll: a birthday day off is paid and leaves the paid-day-off allowance alone", () => {
  const staff = { fixed_salary_amd: 300000, paid_dayoffs_per_month: 1, visit_based: false, commission_basis: "none" };
  const marks = new Map([["2026-11-04", "birthday_off"], ["2026-11-05", "dayoff"], ["2026-11-06", "dayoff"]]);
  const pay = computeMonthPay(staff, "2026-11", { today: "2026-11-30", holidays: new Set(), marks, visits: new Map(), items: [] });
  const state = (d) => pay.days.find((x) => x.date === d).state;
  assert.equal(state("2026-11-04"), "dayoff_paid");
  assert.equal(state("2026-11-05"), "dayoff_paid"); // the one allowed paid day off is still there
  assert.equal(state("2026-11-06"), "dayoff_unpaid");
});

test("the birthday wordings: warm, at most three sentences, no age, the gift sentence in every greeting", async () => {
  const { pickVariant, variantCount } = await import("../../src/team/vaghinak/phrases.js");
  for (const [kind, gift] of [["birthday", true], ["birthday_wishes", false]]) {
    for (const audience of ["rep", "management"]) {
      const used = [];
      for (let i = 0; i < variantCount(kind, 1, audience); i++) {
        const { text, variant } = pickVariant(kind, 1, audience, { addr: "Արտակ", names: "Աննա, Վարդան" }, used);
        used.push(variant);
        const sentences = text.split(/[։]/).map((s) => s.trim()).filter(Boolean);
        assert.ok(sentences.length <= 3, `${kind}/${audience}: ${text}`);
        assert.ok(!/\d{2}/.test(text), `no number (age) in: ${text}`);
        assert.ok(!/խնդրում եմ/.test(text), text);
        if (gift) assert.ok(text.includes("ներքևում"), `gift sentence in: ${text}`);
      }
    }
  }
});
