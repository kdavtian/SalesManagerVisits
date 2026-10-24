// The colour of a sales rep on the map ("Colour by Rep", owner 2026-10-24). The admin picks it in Team management (users.map_color); a rep without a
// chosen colour gets a stable one from this palette, so the ring never depends on who looks.
export const REP_COLORS = ["#d6403f", "#f08a24", "#e0b000", "#1a7f37", "#0e9aa7", "#0a69da", "#4f46e5", "#8e44ad", "#d6336c", "#8d6e63"];

export const repColor = (userId, chosen) => chosen || REP_COLORS[Math.abs(Number(userId) || 0) % REP_COLORS.length];
