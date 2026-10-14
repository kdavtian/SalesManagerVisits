// What is going on with ONE rep right now, from facts only (no database, no wording): the rules of Vaghinak's
// control loop. The engine (engine.js) loads the facts, calls this, and turns the returned actions into messages.
//
// checkins: today's check-ins of the rep, oldest first: { atMin (minute of the Yerevan day), isOffice }.
// plannedCount / visitedPlanned: today's plan size and how many of those customers have a field visit today.
export function evaluateRep({ nowMin, settings: s, checkins, plannedCount, visitedPlanned }) {
  const first = checkins[0] ?? null;
  const last = checkins[checkins.length - 1] ?? null;
  const field = checkins.filter((c) => !c.isOffice);

  // trailing run of office check-ins = "at the office since ..."
  let officeSince = null;
  for (let i = checkins.length - 1; i >= 0 && checkins[i].isOffice; i--) officeSince = checkins[i].atMin;
  const atOffice = last?.isOffice === true;

  const remaining = Math.max(0, plannedCount - visitedPlanned);
  const lateMinutes = first ? Math.max(0, first.atMin - s.workStartMin) : Math.max(0, nowMin - s.workStartMin);
  const officeMinutes = atOffice ? Math.max(0, nowMin - officeSince) : 0;
  const idleMinutes = last && !atOffice ? Math.max(0, nowMin - last.atMin) : 0;

  const facts = {
    started: Boolean(first),
    firstMin: first?.atMin ?? null,
    lateMinutes,
    atOffice,
    officeMinutes,
    idleMinutes,
    remaining,
    plannedCount,
    visitedPlanned,
    fieldVisits: field.length,
  };

  const actions = [];
  const duringWork = nowMin >= s.workStartMin && nowMin < s.workEndMin;
  if (duringWork) {
    if (!first) {
      // nobody checked in yet: ask, later insist
      if (nowMin >= s.workStartMin + s.notStartedMandatoryMin) actions.push({ kind: "not_started", level: 2 });
      else if (nowMin >= s.workStartMin + s.notStartedAskMin) actions.push({ kind: "not_started", level: 1 });
    } else if (first.atMin - s.workStartMin > s.lateGraceMin) {
      // more than the allowed delay: a friendly word (once). Up to the grace he stays quiet.
      actions.push({ kind: "late_start", level: 1 });
    }
    if (atOffice && remaining > 0) {
      if (officeMinutes >= s.officeAskMin) actions.push({ kind: "office_long", level: 2 });
      else if (officeMinutes >= s.officeWarnMin) actions.push({ kind: "office_long", level: 1 });
    }
    if (!atOffice && field.length > 0 && remaining > 0) {
      if (idleMinutes >= s.idleAskMin) actions.push({ kind: "stopped_early", level: 2 });
      else if (idleMinutes >= s.idleWarnMin) actions.push({ kind: "stopped_early", level: 1 });
    }
  }
  return { facts, actions };
}

// The reasons a rep shows up in the management brief / Team pulse (short codes, wording added by the caller).
export function flagsOf(facts, s, nowMin) {
  const flags = [];
  const duringWork = nowMin >= s.workStartMin && nowMin < s.workEndMin;
  if (!duringWork) return flags; // outside working hours nothing is "wrong"
  if (!facts.started) {
    if (nowMin >= s.workStartMin + s.notStartedAskMin) flags.push({ code: "not_started" });
  } else if (facts.lateMinutes > s.lateGraceMin) flags.push({ code: "late", minutes: facts.lateMinutes });
  if (facts.atOffice && facts.remaining > 0 && facts.officeMinutes >= s.officeWarnMin) flags.push({ code: "office_long", minutes: facts.officeMinutes, remaining: facts.remaining });
  if (!facts.atOffice && facts.fieldVisits > 0 && facts.remaining > 0 && facts.idleMinutes >= s.idleWarnMin) flags.push({ code: "stopped_early", minutes: facts.idleMinutes, remaining: facts.remaining });
  return flags;
}
