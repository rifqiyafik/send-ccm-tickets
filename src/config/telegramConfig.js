import { createLogger } from "../utils/logger.js";

const logger = createLogger("telegramConfig");

function parseChatIds(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// #penjelasan: membaca konfigurasi Telegram dari .env agar token dan admin tidak hardcode di source.
export function getTelegramConfig() {
  const config = {
    bot_token: process.env.TELEGRAM_BOT_TOKEN || "",
    admin_chat_ids: parseChatIds(process.env.TELEGRAM_ADMIN_CHAT_IDS),
    poll_timeout_seconds: Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 30),
    wa_auto_start: String(process.env.WA_AUTO_START || "false").toLowerCase() === "true",
  };

  logger.info("Telegram config loaded", {
    hasBotToken: Boolean(config.bot_token),
    adminChatIds: config.admin_chat_ids.length,
    pollTimeoutSeconds: config.poll_timeout_seconds,
    waAutoStart: config.wa_auto_start,
  });

  return config;
}
