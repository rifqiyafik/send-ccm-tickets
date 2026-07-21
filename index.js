import "dotenv/config";

import { createTelegramBot } from "./src/bots/telegramBot.js";
import { getTelegramConfig } from "./src/config/telegramConfig.js";
import { createTelegramCommandHandler } from "./src/handlers/telegramCommandHandler.js";
import { startBot } from "./src/handlers/whatsappMessageHandler.js";
import { createWhatsAppSessionService } from "./src/services/whatsappSessionService.js";
import { createLogger } from "./src/utils/logger.js";

const logger = createLogger("index");

// #penjelasan: entry point aplikasi; Telegram menjadi command center, WhatsApp dikontrol via /login dan /logout.
async function main() {
  const telegramConfig = getTelegramConfig();

  if (!telegramConfig.bot_token) {
    logger.warn(
      "TELEGRAM_BOT_TOKEN empty, starting WhatsApp bot directly for backward compatibility",
    );
    await startBot();
    return;
  }

  let telegramBot;
  const whatsappSession = createWhatsAppSessionService({
    sendTelegramMessage: (chatId, text, options) =>
      telegramBot.sendMessage(chatId, text, options),
  });
  const handleTelegramUpdate = createTelegramCommandHandler({
    config: telegramConfig,
    whatsappSession,
  });

  telegramBot = createTelegramBot({
    config: telegramConfig,
    handleUpdate: handleTelegramUpdate,
  });

  if (telegramConfig.wa_auto_start) {
    await whatsappSession.login(telegramConfig.admin_chat_ids[0]);
  }

  await telegramBot.start();
}

main().catch((error) => {
  logger.error("Failed to start bot application", error);
  process.exit(1);
});
