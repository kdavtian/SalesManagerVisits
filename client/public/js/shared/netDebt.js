// NET debt (owner, 2026-11-03): the live debt minus the frozen credit amount, never below 0. A customer who is in advance (negative live
// debt) keeps that advance: frozen credit only ever lowers a debt that exists. The ONE function every screen, job and check uses.
export function netDebt(liveDebtAmd, frozenAmd = 0) {
  const live = Number(liveDebtAmd) || 0;
  const frozen = Math.max(0, Number(frozenAmd) || 0);
  return live > 0 ? Math.max(0, live - frozen) : live;
}

// How much of the frozen amount actually lowers the debt right now (the rest has nothing to freeze).
export function frozenApplied(liveDebtAmd, frozenAmd = 0) {
  const live = Number(liveDebtAmd) || 0;
  return live > 0 ? Math.min(live, Math.max(0, Number(frozenAmd) || 0)) : 0;
}
