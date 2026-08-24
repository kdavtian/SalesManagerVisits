// Pushes short alerts (order placed, plan pending review, a large payment
// collected) straight to Telegram, independent of the CEO bot's own
// process -- Telegram's Bot API is a plain HTTPS endpoint, so this needs
// only the bot token, not the castrol_ceo_report bot to be running.
// Silently disabled (logged once at boot) if unconfigured, same pattern as
// ERP_SYNC_KEY.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_NOTIFY_CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const enabled = Boolean(BOT_TOKEN && CHAT_IDS.length);

if (!enabled) {
  console.warn(
    "TELEGRAM_BOT_TOKEN / TELEGRAM_NOTIFY_CHAT_IDS not set -- Telegram notifications are disabled."
  );
}

// Telegram's HTML parse_mode treats <, >, & specially -- any user-supplied
// text (a customer or rep name) going into a message needs this first, or
// a name containing one of those characters could break the message
// formatting or, worst case, inject markup.
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function notifyTelegram(text) {
  if (!enabled) return;
  await Promise.all(
    CHAT_IDS.map(async (chatId) => {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        });
        if (!res.ok) {
          console.error(`Telegram notify failed for chat ${chatId}: ${res.status} ${await res.text()}`);
        }
      } catch (err) {
        // Never let a notification failure break the request that triggered
        // it -- this is a best-effort side channel, not a critical path.
        console.error(`Telegram notify error for chat ${chatId}:`, err.message);
      }
    })
  );
}
