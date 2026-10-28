// "Ajapnyak / Yuxman ket1", "Ajapnyak / Yuxman ket2" ...: the suggested name of a new customer is the area plus a word for
// its type plus a running number, so customers of the same type in the same subregion can be told apart (owner, 2026-10-17).
// A legacy name without a number ("Ajapnyak / Yuxman ket") counts as number 1.
export function nextNameNumber(base, names) {
  const escaped = String(base).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*(\\d*)\\s*$`, "i");
  let max = 0;
  for (const name of names) {
    const m = re.exec(String(name ?? ""));
    if (!m) continue;
    max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  return max + 1;
}
