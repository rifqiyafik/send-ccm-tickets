import { createLogger } from "../utils/logger.js";
import {
  createTelegramRichMessage,
  splitTelegramMessageText,
} from "../utils/telegramFormat.js";
import {
  formatRegisteredTelegramChatsList,
  formatTelegramRegisterRequest,
  isAuthorizedTelegramChat,
  listAuthorizedTelegramChats,
  registerTelegramChat,
} from "../services/telegramAccessService.js";
import {
  formatWhatsAppGroupsCommand,
  formatWhatsAppPrivateCommand,
  sendImportResult,
} from "./whatsappMessageHandler.js";
import { processTicketExcel } from "../services/ticketImportService.js";

const logger = createLogger("telegramCommandHandler");
const TELEGRAM_SOURCE_PREFIX = "telegram:";

function getMessageText(update) {
  return String(update.message?.text || "").trim();
}

function getChatId(update) {
  return String(update.message?.chat?.id || "");
}

function getChat(update) {
  return update.message?.chat || null;
}

function getFrom(update) {
  return update.message?.from || null;
}

function getDocument(update) {
  return update.message?.document || null;
}

function parseCommand(text) {
  const [command = "", ...args] = String(text || "")
    .trim()
    .split(/\s+/);
  return {
    command: command.toLowerCase(),
    argument: args.join(" ").trim(),
  };
}

function isSupportedTelegramExcelFile(document) {
  const fileName = String(document?.file_name || "").toLowerCase();
  const mimetype = String(document?.mime_type || "").toLowerCase();
  logger.info("Validating Telegram document format", { fileName, mimetype });

  return (
    fileName.endsWith(".xlsx") ||
    mimetype ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

function createTelegramWhatsAppAdapter({
  sourceChatId,
  sendDocument,
  sendMessage,
  whatsappSock,
}) {
  const sourceJid = `${TELEGRAM_SOURCE_PREFIX}${sourceChatId}`;

  return {
    sourceJid,
    async sendMessage(jid, payload) {
      if (jid === sourceJid) {
        if (payload?.document) {
          await sendDocument(sourceChatId, payload.document, {
            mimetype: payload.mimetype,
            fileName: payload.fileName,
            caption: payload.caption,
          });
          return;
        }

        if (payload?.text) {
          await sendRichMessage(sendMessage, sourceChatId, payload.text);
          return;
        }

        logger.warn("Telegram source payload skipped: unsupported payload", {
          sourceChatId,
          keys: Object.keys(payload || {}),
        });
        return;
      }

      if (!whatsappSock?.sendMessage) {
        throw new Error("WhatsApp session belum aktif. Jalankan /login dulu.");
      }

      await whatsappSock.sendMessage(jid, payload);
    },
  };
}

function isAdminChat(chatId, config) {
  return config.admin_chat_ids.includes(String(chatId));
}

function parseRegisterArgument(argument) {
  const [chatId = "", ...labelParts] = String(argument || "")
    .trim()
    .split(/\s+/);

  return {
    chatId,
    label: labelParts.join(" ").trim(),
  };
}

function detectTelegramChatType(chatId) {
  return String(chatId || "")
    .trim()
    .startsWith("-")
    ? "group"
    : "private";
}

function formatHelp() {
  return [
    "🤖 **CCM Ticket Bot - Telegram Command Center**",
    "",
    "📌 **Command List:**",
    "",
    "### 🔹 Basic Commands",
    "- `/start` → Mulai bot",
    "- `/help` → Lihat panduan",
    "- `/status` → Cek status koneksi",
    "- `/register` → Request whitelist chat/group Telegram",
    "",
    "### 🔐 Session Management",
    "- `/login` → Nyalakan session WhatsApp & kirim QR ke Telegram",
    "- `/logout` → Putus session WhatsApp & hapus folder session lokal",
    "",
    "### 📂 Group & Private Access",
    "- `/groups [keyword]` → Lihat daftar grup WhatsApp aktif",
    "- `/private [keyword]` → Lihat daftar private chat aktif",
    "- `/register <chat_id> [label]` → Admin approve whitelist Telegram",
    "- `/whitelist` → Admin lihat whitelist Telegram",
    "",
    "---",
    "📝 **Notes:**",
    "- `/login` menyalakan session WhatsApp dan mengirim QR ke Telegram.",
    "- `/logout` memutus session WhatsApp dan menghapus folder session lokal.",
    "- `/groups` dan `/private` membaca index dari session WhatsApp aktif.",
    "- File Excel Telegram hanya boleh dikirim dari group/private Telegram yang sudah whitelist.",
    "- File Excel WhatsApp tetap mengikuti whitelist WhatsApp.",
  ].join("\n");
}

function formatStatus(whatsappStatus) {
  return [
    "📊 **Bot Status**",
    "",
    `🟢 WhatsApp Running: ${whatsappStatus.running ? "✅ YES" : "❌ NO"}`,
    `👤 WhatsApp User: ${whatsappStatus.user?.id || whatsappStatus.user?.name || "-"}`,
    `📂 Auth Directory: ${whatsappStatus.authDir}`,
    `👥 QR Subscribers: ${whatsappStatus.qr_subscribers}`,
    "",
    "---",
    "ℹ️ Gunakan `/status` untuk cek kondisi terbaru bot.",
  ].join("\n");
}

async function sendRichMessage(sendMessage, chatId, text, options = {}) {
  const chunks = splitTelegramMessageText(text);
  logger.info("Sending Telegram rich message chunks", {
    chatId,
    chunks: chunks.length,
    originalLength: String(text || "").length,
  });

  for (const [index, chunk] of chunks.entries()) {
    const message = createTelegramRichMessage(chunk, options);
    await sendMessage(chatId, message.text, message.options);
    logger.info("Telegram rich message chunk sent", {
      chatId,
      chunk: index + 1,
      chunks: chunks.length,
      length: message.text.length,
    });
  }
}

async function sendToAdmins(sendMessage, config, text) {
  if (config.admin_chat_ids.length === 0) {
    logger.warn(
      "Telegram approval request cannot be sent: admin list is empty",
    );
    return false;
  }

  for (const adminChatId of config.admin_chat_ids) {
    await sendRichMessage(sendMessage, adminChatId, text);
  }

  return true;
}

// semua command operasional diarahkan ke Telegram agar WhatsApp fokus menerima Excel dan kirim tiket.
export function createTelegramCommandHandler({ config, whatsappSession }) {
  return async function handleTelegramUpdate(
    update,
    { downloadFile, sendDocument, sendMessage },
  ) {
    const chatId = getChatId(update);
    const chat = getChat(update);
    const from = getFrom(update);
    const document = getDocument(update);
    const text = getMessageText(update);

    if (chatId && document) {
      const admin = isAdminChat(chatId, config);
      const authorized = admin || (await isAuthorizedTelegramChat(chatId));
      logger.info("Incoming Telegram document", {
        chatId,
        fileName: document.file_name,
        authorized,
      });

      if (!authorized) {
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "⛔ **File Excel ditolak.**",
            "",
            "🚫 Chat ini belum masuk **whitelist Telegram**.",
            "",
            "📋 **Detail:**",
            `🆔 Chat ID: \`${chatId}\``,
            `📄 File: \`${document.file_name || "-"}\``,
            "",
            "👉 Kirim `/register` untuk minta approval admin.",
          ].join("\n"),
        );
        return;
      }

      if (!isSupportedTelegramExcelFile(document)) {
        logger.warn("Telegram document rejected: unsupported format", {
          chatId,
          fileName: document.file_name,
          mimetype: document.mime_type,
        });
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "⚠️ **Format File Belum Didukung**",
            "",
            "📄 Bot hanya membaca file Excel `.xlsx`.",
            "",
            "📋 **Detail:**",
            `📄 File: \`${document.file_name || "-"}\``,
            `🧾 MIME: \`${document.mime_type || "-"}\``,
            "",
            "👉 Save As ke **Excel Workbook (*.xlsx)** lalu kirim ulang.",
          ].join("\n"),
        );
        return;
      }

      const whatsappSock = whatsappSession.getSocket();
      if (!whatsappSock?.sendMessage) {
        logger.warn("Telegram Excel rejected: WhatsApp session is not active", {
          chatId,
          fileName: document.file_name,
        });
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "⚠️ **WhatsApp Session Belum Aktif**",
            "",
            "📤 File sudah diterima Telegram, tapi bot belum bisa meneruskan tiket ke grup WhatsApp.",
            "",
            "👉 Jalankan `/login`, scan QR WhatsApp, lalu kirim ulang file Excel.",
          ].join("\n"),
        );
        return;
      }

      await sendRichMessage(
        sendMessage,
        chatId,
        [
          "📂 **File Excel Diterima**",
          "",
          "⏳ Sedang memproses tiket dan meneruskan ke grup WhatsApp target...",
          `📄 File Name: \`${document.file_name || "-"}\``,
        ].join("\n"),
      );

      try {
        const buffer = await downloadFile(document.file_id);
        logger.info("Starting Telegram ticket Excel process", {
          chatId,
          fileName: document.file_name,
          bytes: buffer.length,
        });
        const result = await processTicketExcel(buffer);
        logger.info("Telegram ticket Excel process completed", {
          chatId,
          total: result.total_rows,
          valid: result.valid_count || 0,
          skipped: result.skipped_count || 0,
        });

        const adapter = createTelegramWhatsAppAdapter({
          sourceChatId: chatId,
          sendDocument,
          sendMessage,
          whatsappSock,
        });
        await sendImportResult(adapter, adapter.sourceJid, result);
      } catch (error) {
        logger.error("Failed to process Telegram Excel", error);
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "❌ **Gagal Memproses File Excel**",
            "",
            `🛑 Error: \`${error.message}\``,
            "",
            "👉 Pastikan format file sesuai lalu kirim ulang.",
          ].join("\n"),
        );
      }
      return;
    }

    if (!chatId || !text.startsWith("/")) {
      return;
    }

    const { command, argument } = parseCommand(text);
    logger.info("Incoming Telegram command", {
      chatId,
      command,
      argument,
    });

    const admin = isAdminChat(chatId, config);

    if (command === "/register" && !argument && admin) {
      await sendRichMessage(
        sendMessage,
        chatId,
        [
          "ℹ️ **Admin Register Usage**",
          "",
          "🔑 Gunakan command berikut untuk approve whitelist Telegram:",
          "",
          "📝 **Format:**",
          "`/register <chat_id> [label]`",
          "",
          "📌 **Contoh:**",
          "`/register -1001234567890 Grup Import Ticket`",
          "`/register 123456789 Rifqi Private`",
        ].join("\n"),
      );
      return;
    }

    if (command === "/register" && !argument) {
      if (await isAuthorizedTelegramChat(chatId)) {
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "✅ **Chat Sudah Terdaftar**",
            "",
            "🎉 Chat ini sudah masuk whitelist Telegram dan boleh mengirim file Excel.",
            "",
            `Chat ID: \`${chatId}\``,
          ].join("\n"),
        );
        return;
      }

      const requestMessage = formatTelegramRegisterRequest({ chat, from });
      const requestSent = await sendToAdmins(
        sendMessage,
        config,
        requestMessage,
      );
      await sendRichMessage(
        sendMessage,
        chatId,
        [
          requestSent
            ? "⏳ **Request Whitelist Terkirim**"
            : "⚠️ **Request Belum Bisa Dikirim**",
          "",
          `🆔 Chat ID: \`${chatId}\``,
          `📌 Status: ${requestSent ? "**Menunggu approval admin**" : "**Admin belum dikonfigurasi**"}`,
          "",
          requestSent
            ? "🕒 Tunggu admin approve sebelum mengirim file Excel dari chat ini."
            : "TELEGRAM_ADMIN_CHAT_IDS belum diisi. Kirim Chat ID ini ke owner bot.",
        ].join("\n"),
      );
      return;
    }

    const authorized = admin || (await isAuthorizedTelegramChat(chatId));

    if (!authorized) {
      logger.warn("Telegram command rejected: unauthorized chat", {
        chatId,
        command,
      });
      await sendRichMessage(
        sendMessage,
        chatId,
        [
          "⛔ **Unauthorized Telegram Chat**",
          "",
          "🚫 Chat ini belum punya akses ke bot.",
          "",
          "📋 **Detail:**",
          `🆔 Chat ID: \`${chatId}\``,
          "⚠️ Status: **Belum whitelist Telegram**",
          "",
          "👉 Kirim `/register` untuk minta approval admin.",
        ].join("\n"),
      );
      return;
    }

    if (command === "/start" || command === "/help") {
      await sendRichMessage(sendMessage, chatId, formatHelp());
      return;
    }

    if (!admin && !["/start", "/help", "/status"].includes(command)) {
      logger.warn("Telegram admin command rejected from non-admin chat", {
        chatId,
        command,
      });
      await sendRichMessage(
        sendMessage,
        chatId,
        [
          "⛔ **Command ini hanya untuk admin Telegram.**",
          "",
          "🔐 Akses command ini dibatasi untuk admin.",
          "",
          `📝 Command: \`${command}\``,
        ].join("\n"),
      );
      return;
    }

    if (command === "/register") {
      const { chatId: targetChatId, label } = parseRegisterArgument(argument);
      const targetChatType = detectTelegramChatType(targetChatId);
      const registered = await registerTelegramChat({
        chatId: targetChatId,
        label: label || targetChatId,
        type: targetChatType,
        registeredBy: chatId,
      });
      await sendRichMessage(
        sendMessage,
        chatId,
        [
          "✅ **Telegram Chat Registered**",
          "",
          "🎉 Chat berhasil masuk whitelist Telegram.",
          "",
          "📋 **Detail:**",
          `🆔 Chat ID: \`${registered.id}\``,
          `🏷️ Label: **${registered.label}**`,
          `📌 Type: \`${registered.type}\``,
          "",
          "✅ Chat ini sekarang boleh mengirim file Excel ke bot Telegram.",
        ].join("\n"),
      );
      return;
    }

    if (command === "/whitelist") {
      await sendRichMessage(
        sendMessage,
        chatId,
        formatRegisteredTelegramChatsList(await listAuthorizedTelegramChats()),
      );
      return;
    }

    if (command === "/status") {
      await sendRichMessage(
        sendMessage,
        chatId,
        formatStatus(whatsappSession.getStatus()),
      );
      return;
    }

    if (command === "/login") {
      const result = await whatsappSession.login(chatId);
      await sendRichMessage(sendMessage, chatId, result);
      return;
    }

    if (command === "/logout") {
      const result = await whatsappSession.logout();
      await sendRichMessage(sendMessage, chatId, result);
      return;
    }

    if (command === "/groups") {
      await sendRichMessage(
        sendMessage,
        chatId,
        await formatWhatsAppGroupsCommand(argument),
      );
      return;
    }

    if (command === "/private") {
      await sendRichMessage(
        sendMessage,
        chatId,
        formatWhatsAppPrivateCommand(argument),
      );
      return;
    }

    logger.warn("Telegram command ignored: unsupported command", {
      chatId,
      command,
    });
    await sendRichMessage(
      sendMessage,
      chatId,
      [
        "❓ **Command Tidak Dikenal**",
        "",
        `📝 Command: \`${command}\``,
        "",
        "👉 Ketik `/help` untuk melihat daftar command.",
      ].join("\n"),
    );
  };
}
