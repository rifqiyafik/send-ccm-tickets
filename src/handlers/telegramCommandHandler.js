import { createLogger } from "../utils/logger.js";
import {
  formatWhatsAppGroupsCommand,
  formatWhatsAppPrivateCommand,
} from "./whatsappMessageHandler.js";

const logger = createLogger("telegramCommandHandler");

function getMessageText(update) {
  return String(update.message?.text || "").trim();
}

function getChatId(update) {
  return String(update.message?.chat?.id || "");
}

function parseCommand(text) {
  const [command = "", ...args] = String(text || "").trim().split(/\s+/);
  return {
    command: command.toLowerCase(),
    argument: args.join(" ").trim(),
  };
}

function isAdminChat(chatId, config) {
  return config.admin_chat_ids.includes(String(chatId));
}

function formatHelp() {
  return [
    "CCM Ticket Bot - Telegram Command Center",
    "",
    "Command:",
    "/start",
    "/help",
    "/status",
    "/login",
    "/logout",
    "/groups [keyword]",
    "/private [keyword]",
    "",
    "Catatan:",
    "- /login menyalakan session WhatsApp dan mengirim QR ke Telegram.",
    "- /logout memutus session WhatsApp dan menghapus folder session lokal.",
    "- /groups dan /private membaca index dari session WhatsApp aktif.",
    "- File Excel tetap dikirim lewat WhatsApp group/private yang sudah whitelist.",
  ].join("\n");
}

function formatStatus(whatsappStatus) {
  return [
    "Bot status",
    "",
    `WhatsApp running: ${whatsappStatus.running ? "YES" : "NO"}`,
    `WhatsApp user: ${whatsappStatus.user?.id || whatsappStatus.user?.name || "-"}`,
    `Auth dir: ${whatsappStatus.authDir}`,
    `QR subscribers: ${whatsappStatus.qr_subscribers}`,
  ].join("\n");
}

// #penjelasan: semua command operasional diarahkan ke Telegram agar WhatsApp fokus menerima Excel dan kirim tiket.
export function createTelegramCommandHandler({ config, whatsappSession }) {
  return async function handleTelegramUpdate(update, { sendMessage }) {
    const chatId = getChatId(update);
    const text = getMessageText(update);
    if (!chatId || !text.startsWith("/")) {
      return;
    }

    const { command, argument } = parseCommand(text);
    logger.info("Incoming Telegram command", {
      chatId,
      command,
      argument,
    });

    if (!isAdminChat(chatId, config)) {
      logger.warn("Telegram command rejected: unauthorized chat", {
        chatId,
        command,
      });
      await sendMessage(
        chatId,
        [
          "Unauthorized Telegram chat.",
          "",
          `Chat ID kamu: ${chatId}`,
          "Masukkan Chat ID ini ke TELEGRAM_ADMIN_CHAT_IDS di .env jika memang admin.",
        ].join("\n"),
      );
      return;
    }

    if (command === "/start" || command === "/help") {
      await sendMessage(chatId, formatHelp());
      return;
    }

    if (command === "/status") {
      await sendMessage(chatId, formatStatus(whatsappSession.getStatus()));
      return;
    }

    if (command === "/login") {
      const result = await whatsappSession.login(chatId);
      await sendMessage(chatId, result);
      return;
    }

    if (command === "/logout") {
      const result = await whatsappSession.logout();
      await sendMessage(chatId, result);
      return;
    }

    if (command === "/groups") {
      await sendMessage(chatId, await formatWhatsAppGroupsCommand(argument));
      return;
    }

    if (command === "/private") {
      await sendMessage(chatId, formatWhatsAppPrivateCommand(argument));
      return;
    }

    logger.warn("Telegram command ignored: unsupported command", {
      chatId,
      command,
    });
    await sendMessage(chatId, `Command tidak dikenal: ${command}\nKetik /help.`);
  };
}
