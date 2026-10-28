// Night-time quiet hours for PUSH notifications (owner's rule, 2026-10): no
// phone buzzing between 22:00 and 07:59 Yerevan time. The notification itself
// is still saved and shows in the in-app bell; only the push is skipped.
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8; // exclusive

export function isQuietHours(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}
