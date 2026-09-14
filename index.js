import "dotenv/config";

import { createTelegramBot } from "./src/bots/telegramBot.js";
import { getTelegramConfig } from "./src/config/telegramConfig.js";
import {
  createTelegramCommandHandler,
  createTelegramWhatsAppAdapter,
} from "./src/handlers/telegramCommandHandler.js";
import { startBot } from "./src/handlers/whatsappMessageHandler.js";
import { createWhatsAppSessionService } from "./src/services/whatsappSessionService.js";
import { createTicketPollingService } from "./src/services/ticketPollingService.js";
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
  let ticketPolling;

  const whatsappSession = createWhatsAppSessionService({
    sendTelegramMessage: (chatId, text, options) =>
      telegramBot.sendMessage(chatId, text, options),
    sendTelegramPhoto: (chatId, photo, options) =>
      telegramBot.sendPhoto(chatId, photo, options),
  });

  const createAdapter = (chatId) =>
    createTelegramWhatsAppAdapter({
      ensureWhatsAppReady: ({ forceRecover = false } = {}) =>
        whatsappSession.ensureReady({ forceRecover, chatId }),
      getWhatsAppSocket: () => whatsappSession.getSocket(),
      sourceChatId: chatId,
      sendDocument: (id, doc, opts) => telegramBot.sendDocument(id, doc, opts),
      sendMessage: (id, txt, opts) => telegramBot.sendMessage(id, txt, opts),
      editMessageText: (id, msgId, txt, opts) =>
        telegramBot.editMessageText(id, msgId, txt, opts),
      manualMode: false,
    });

  ticketPolling = createTicketPollingService({
    telegramBot: {
      sendMessage: (id, txt, opts) => telegramBot.sendMessage(id, txt, opts),
    },
    adminChatIds: telegramConfig.admin_chat_ids || [],
    createAdapter,
  });

  const handleTelegramUpdate = createTelegramCommandHandler({
    config: telegramConfig,
    whatsappSession,
    ticketPolling,
  });

  telegramBot = createTelegramBot({
    config: telegramConfig,
    handleUpdate: handleTelegramUpdate,
  });

  if (telegramConfig.wa_auto_start) {
    await whatsappSession.startSavedSession(telegramConfig.admin_chat_ids[0]);
  }

  // Mulai auto-polling database jika diaktifkan di .env
  const isDbPollEnabled =
    process.env.DB_POLL_ENABLED === "true" ||
    (process.env.DB_POLL_ENABLED !== "false" &&
      Boolean(process.env.CLICKHOUSE_HOST || process.env.DB_HOST));

  if (isDbPollEnabled) {
    logger.info("Auto DB ticket polling is enabled, starting background service");
    ticketPolling.start();
  } else {
    logger.info("Auto DB ticket polling is disabled (DB_POLL_ENABLED=false)");
  }

  await telegramBot.start();
}

main().catch((error) => {
  logger.error("Failed to start bot application", error);
  process.exit(1);
});
