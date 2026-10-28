// One phone format everywhere it is shown or printed: +374 91 007 019 (country code, 2-digit operator code,
// then 3 + 3 digits -- owner's format, 2026-10-10). Phones are STORED as digits only: +37491007019
// (see normalizePhoneForStorage), so search, tel:/WhatsApp links, Lily and the exports stay simple.
// Accepts 091007019, 91007019, 091-007-019, +37491007019 or +(374) 91 007 019;
// anything that is not an Armenian number is shown as typed.
// The 8 national digits of an Armenian number given in any of the usual shapes, else null.
function armenianNational(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("374")) return digits.slice(3);
  if (digits.length === 9 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 8) return digits;
  return null;
}

export function formatPhone(phone) {
  const national = armenianNational(phone);
  if (!national) return String(phone ?? "").trim();
  return `+374 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
}

// What goes into the database: "+37491007019" for an Armenian number, null for empty, anything
// else (a foreign number, free text) trimmed and otherwise left alone.
export function normalizePhoneForStorage(phone) {
  if (phone === null || phone === undefined) return null;
  const text = String(phone).trim();
  if (!text) return null;
  const national = armenianNational(text);
  if (national) return `+374${national}`;
  // A bare "+374" / "+374 " left in a prefilled field means "nothing typed".
  if (/^\+?374\s*$/.test(text)) return null;
  return text;
}
