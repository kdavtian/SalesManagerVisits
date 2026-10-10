// One phone format everywhere it is printed: +374 91 007019 (country code, 2-digit operator code, then the
// 6 remaining digits together -- owner's format, 2026-10-10).
// Accepts 091007019, 91007019, 091-007-019, +37491007019 or +(374) 91 007 019;
// anything that is not an Armenian number is printed as typed.
export function formatPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  let national = null;
  if (digits.length === 11 && digits.startsWith("374")) national = digits.slice(3);
  else if (digits.length === 9 && digits.startsWith("0")) national = digits.slice(1);
  else if (digits.length === 8) national = digits;
  if (!national) return String(phone ?? "").trim();
  return `+374 ${national.slice(0, 2)} ${national.slice(2)}`;
}
