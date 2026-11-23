// The one Cash screen (owner, 2026-11-23: one screen per role instead of six). One answer for it:
//   me          the cash in MY hands, my hand-overs still waiting for their receiver, my open shortfall, whom I hand to next
//   to_confirm  hand-overs waiting for ME to count (admin and the CEO: everybody's, they may decide any)
//   company     (everybody who sees all payments) where the company's cash is right now, by place and by person; what reached the
//               office today; what the Excel does not have yet; open shortfalls; bank lines to check
// Places are the ones of shared/cashPlace.js. "In hands" follows cashCustody.js, so the sums equal the hand-over lists.
import { pool } from "../db/pool.js";
import { CASH_IN_HAND_SQL } from "./cashCustody.js";
import { CASH_PLACE_JOINS, CASH_PLACE_SQL } from "./cashPlaceSql.js";
import { moneyBoard } from "./payments2/board.js";
import { decidesAnyHandoff, seesAllPayments, validHandoffRecipientRoles, canRecordBankPayments } from "../shared/roles.js";
import { yerevanToday } from "../utils/yerevanDate.js";

const n = (v) => Math.round(Number(v) || 0);

export async function cashOverview(user, db = pool) {
  const sendsTo = validHandoffRecipientRoles(user.role);
  const [mine, waiting, short, toConfirm, next] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(p.amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM payments p
       WHERE p.current_holder_id = $1 AND p.pending_handoff_id IS NULL AND ${CASH_IN_HAND_SQL}`,
      [user.id]
    ),
    db.query(
      `SELECT h.id, tu.name AS to_name, h.amount_amd::float8 AS amd, h.submitted_at FROM cash_handoffs h JOIN users tu ON tu.id = h.to_user_id
       WHERE h.from_user_id = $1 AND h.status = 'pending' ORDER BY h.submitted_at`,
      [user.id]
    ),
    db.query("SELECT COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM cash_shortfalls WHERE user_id = $1 AND status = 'open'", [user.id]),
    db.query(
      `SELECT h.id, fu.name AS from_name, tu.name AS to_name, h.to_user_id, h.amount_amd::float8 AS amd, h.submitted_at,
              (SELECT count(*)::int FROM cash_handoff_items i WHERE i.handoff_id = h.id) AS n
       FROM cash_handoffs h JOIN users fu ON fu.id = h.from_user_id JOIN users tu ON tu.id = h.to_user_id
       WHERE h.status = 'pending' AND (h.to_user_id = $1 OR ($2 AND h.from_user_id <> $1 AND h.submitted_by <> $1)) ORDER BY h.submitted_at`,
      [user.id, decidesAnyHandoff(user.role)]
    ),
    sendsTo.length
      ? db.query(
          // the same first choice as the hand-over screen: my boss in Staff, then a sales director, then the rest
          `SELECT u.id, u.name FROM users u WHERE u.role = ANY($1) AND u.status = 'active'
           ORDER BY (u.id = (SELECT boss.user_id FROM staff_members me JOIN staff_members boss ON boss.id = me.reports_to WHERE me.user_id = $2 LIMIT 1)) DESC NULLS LAST,
                    (u.role = 'sales_director') DESC, u.role, u.name LIMIT 1`,
          [sendsTo, user.id]
        )
      : { rows: [] },
  ]);
  const out = {
    me: {
      amd: n(mine.rows[0].amd),
      n: mine.rows[0].n,
      can_hand_over: sendsTo.length > 0,
      next: next.rows[0] ?? null,
      waiting: waiting.rows.map((r) => ({ id: r.id, to_name: r.to_name, amd: n(r.amd), submitted_at: r.submitted_at })),
      shortfall_amd: n(short.rows[0].amd),
    },
    to_confirm: toConfirm.rows.map((r) => ({ id: r.id, from_name: r.from_name, to_name: r.to_name, mine: r.to_user_id === user.id, amd: n(r.amd), n: r.n, submitted_at: r.submitted_at })),
    company: null,
  };
  if (!seesAllPayments(user.role)) return out;

  const [{ rows: places }, board] = await Promise.all([
    db.query(
      `SELECT ${CASH_PLACE_SQL} AS place, cph.id AS user_id, cph.name, SUM(p.amount_amd)::float8 AS amd, count(*)::int AS n
       FROM payments p ${CASH_PLACE_JOINS}
       WHERE ${CASH_IN_HAND_SQL} AND ${CASH_PLACE_SQL} IN ('with_rep', 'on_the_way', 'with_director')
       GROUP BY 1, 2, 3 ORDER BY amd DESC`
    ),
    moneyBoard(db, yerevanToday()),
  ]);
  const of = (place) => {
    const rows = places.filter((r) => r.place === place);
    return { amd: rows.reduce((s, r) => s + n(r.amd), 0), n: rows.reduce((s, r) => s + r.n, 0), people: rows.map((r) => ({ name: r.name ?? "—", amd: n(r.amd), n: r.n })) };
  };
  out.company = {
    with_rep: of("with_rep"),
    on_the_way: of("on_the_way"),
    with_director: of("with_director"),
    office_today_amd: board.received.amd,
    not_in_excel: board.not_in_excel,
    shortfalls_open: { amd: board.shortfalls.open_amd, n: board.shortfalls.open_n },
    // bank lines to check: only for the people who work with them
    to_check: canRecordBankPayments(user.role) ? board.to_check : null,
  };
  return out;
}
