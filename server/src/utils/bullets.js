// Notification / Vaghinak message bodies: several facts are shown as short bullet lines, never as one long sentence
// with commas (owner, 2026-10-15). "\n" separates the lines; the client renders them with white-space: pre-line.
export const bullets = (items) => items.filter((x) => x !== null && x !== undefined && x !== "").map((x) => `• ${x}`).join("\n");

// The first `max` names as bullets plus a last "…and N more" line.
export const bulletNames = (names, max = 4) => bullets([...names.slice(0, max), names.length > max ? `…և ևս ${names.length - max}` : null]);
