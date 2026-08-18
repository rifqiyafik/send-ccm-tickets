import { createLogger } from "../utils/logger.js";
import {
  createTelegramRichMessage,
  splitTelegramMessageText,
} from "../utils/telegramFormat.js";
import {
  formatRegisteredTelegramChatsList,
  formatTelegramRegisterRequest,
  getTelegramAccessDecision,
  isAuthorizedTelegramChat,
  listAuthorizedTelegramChats,
  registerTelegramChat,
} from "../services/telegramAccessService.js";
import {
  cancelActiveDelivery,
  formatWhatsAppGroupsCommand,
  formatWhatsAppPrivateCommand,
  sendImportResult,
} from "./whatsappMessageHandler.js";
import { processTicketExcel } from "../services/ticketImportService.js";
import {
  changeRuntimeEnvironment,
  formatEnvironmentChangeResult,
  formatEnvironmentChangeUsage,
  formatEnvironmentStatus,
} from "../services/runtimeEnvironmentService.js";

const logger = createLogger("telegramCommandHandler");
const TELEGRAM_SOURCE_PREFIX = "telegram:";

function getMessageText(update) {
  return String(update.message?.text || "").trim();
}

function getMessageCaption(update) {
  return String(update.message?.caption || "").trim();
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

function getTelegramDocumentImportOptions(caption) {
  const text = String(caption || "").trim();
  if (!text) {
    return {
      command: "",
      supported: false,
      missingCommand: true,
      ticketOnlyMode: false,
      summaryOnlyMode: false,
      reminderMode: false,
    };
  }

  if (!text.startsWith(".") && !text.startsWith("/")) {
    return {
      command: text,
      supported: false,
      missingCommand: false,
      ticketOnlyMode: false,
      summaryOnlyMode: false,
      reminderMode: false,
    };
  }

  const { command } = parseCommand(text);
  const normalMode = [".import", ".send", "/import", "/send"].includes(command);
  const ticketOnlyMode = [".update", "/update"].includes(command);
  const summaryOnlyMode = [".summary", "/summary"].includes(command);
  const reminderMode = [".reminder", "/reminder"].includes(command);
  const specialMode = [".special", "/special"].includes(command);

  return {
    command,
    supported:
      normalMode ||
      ticketOnlyMode ||
      summaryOnlyMode ||
      reminderMode ||
      specialMode,
    missingCommand: false,
    ticketOnlyMode,
    summaryOnlyMode,
    reminderMode,
    specialMode,
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
  ensureWhatsAppReady,
  getWhatsAppSocket,
  sourceChatId,
  sendDocument,
  sendMessage,
  editMessageText,
  initialProgressMessageId = null,
}) {
  const sourceJid = `${TELEGRAM_SOURCE_PREFIX}${sourceChatId}`;
  let progressMessageId = initialProgressMessageId;

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
          if (payload.isProgress && editMessageText) {
            if (progressMessageId) {
              await editRichMessage(
                editMessageText,
                sourceChatId,
                progressMessageId,
                payload.text,
              );
              return { message_id: progressMessageId };
            }
            const sent = await sendRichMessage(
              sendMessage,
              sourceChatId,
              payload.text,
            );
            progressMessageId = sent?.message_id || null;
            return sent;
          }

          return await sendRichMessage(sendMessage, sourceChatId, payload.text);
        }

        logger.warn("Telegram source payload skipped: unsupported payload", {
          sourceChatId,
          keys: Object.keys(payload || {}),
        });
        return;
      }

      const whatsappSock =
        (await ensureWhatsAppReady?.()) || getWhatsAppSocket?.();
      if (!whatsappSock?.sendMessage) {
        throw new Error("WhatsApp session belum aktif. Jalankan /login dulu.");
      }

      try {
        await whatsappSock.sendMessage(jid, payload);
      } catch (error) {
        if (!isWhatsAppConnectionClosedError(error)) {
          throw error;
        }

        logger.warn(
          "WhatsApp send failed because socket is closed, retrying with latest socket",
          {
            targetJid: jid,
            message: error.message,
          },
        );
        await wait(1500);

        const latestSock =
          (await ensureWhatsAppReady?.({ forceRecover: true })) ||
          getWhatsAppSocket?.();
        if (!latestSock?.sendMessage || latestSock === whatsappSock) {
          throw error;
        }

        await latestSock.sendMessage(jid, payload);
      }
    },
  };
}

function isWhatsAppConnectionClosedError(error) {
  return /connection closed/i.test(String(error?.message || ""));
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function isAdminOnlyCommand(command) {
  return ["/logout", "/delete_session", "/whitelist", "/change_env"].includes(
    command,
  );
}

function isAdminOnlyRegisterCommand(command, argument) {
  return command === "/register" && Boolean(String(argument || "").trim());
}

function formatTelegramGroupHelp() {
  return [
    "🤖 **Panduan Bot Kirim CCM Ticket (Grup Telegram)**",
    "",
    "⚠️ **Langkah Wajib Sebelum Mengirim File Tiket:**",
    "1. **Cek Koneksi WhatsApp Bot**: Jalankan `/status` terlebih dahulu.",
    "2. **Pastikan Session WhatsApp Aktif**: Jika status `❌ NO` (terputus/stopped), hubungi admin untuk melakukan `/login` di **Chat Personal Bot** terlebih dahulu sebelum mengirimkan file Excel!",
    "",
    "--------------------------------------------------",
    "",
    "📤 **Cara Mengirim File Tiket Excel:**",
    "- Upload file Excel (`.xlsx` / `.xls`) ke chat ini.",
    "- Tambahkan **Caption Command** sesuai kebutuhan:",
    "",
    "🔹 **Mode Pengiriman File:**",
    "• **Tanpa Caption / `.import` / `.send`**: Pengiriman Normal. Detail tiket dikirim ke grup target (SQA & NOP), file balasan Excel dibuat, dan summary dikirim.",
    "• `.update`: Mode Update Cepat. Hanya mengirim detail tiket eskalasi ke grup target (tanpa salam pembuka & summary).",
    "• `.summary`: Mode Ringkasan. Hanya membuat report/summary dan file Excel balasan di chat ini tanpa mengirim detail ke grup target.",
    "• `.reminder`: Mode Reminder Tiket Unresolved. Hanya mengirimkan reminder untuk semua tiket yang belum resolve di file Excel.",
    "• `.special`: Mode Force Resend Tiket. Mengabaikan riwayat database (sent_tickets) dan mengirim ulang seluruh tiket valid.",
    "",
    "--------------------------------------------------",
    "",
    "📊 **Fitur Utama Bot:**",
    "✅ Routing otomatis ke grup target SQA & NOP berdasarkan Region/Cluster.",
    "✅ Tagging / Mention otomatis ke PIC CCM & PIC SQA / NOP.",
    "✅ Deteksi ReOpen & kalkulasi waktu keterlambatan SLA (Out SLA).",
    "✅ Rekap & report filter Excel otomatis.",
    "",
    "ℹ️ *Untuk perintah manajemen sesi, login, dan konfigurasi bot, gunakan `/help` di Chat Personal Bot.*",
  ].join("\n");
}

function formatTelegramPersonalHelp() {
  return [
    "🤖 **CCM Ticket Bot - Admin Command Center (Personal Guide)**",
    "",
    "📌 **Daftar Command Lengkap:**",
    "",
    "### 🔐 WhatsApp Session Management",
    "- `/sessions` → Lihat daftar session WhatsApp tersimpan",
    "- `/login` → Pilihan login & QR session WhatsApp",
    "- `/login 1` → Jalankan/konek session nomor urut",
    "- `/login 6282160478546` → Buat session baru (bot akan minta label nama)",
    "- `/stop` → Info cara matikan session aktif",
    "- `/stop 1` → Matikan koneksi session aktif tanpa hapus credential",
    "- `/logout` → Putus linked device session aktif dari WhatsApp",
    "- `/logout 1` → Logout session nomor urut jika sedang aktif",
    "- `/delete_session 1` → Hapus credential lokal session",
    "- `YA` / `TIDAK` → Konfirmasi pergantian session aktif",
    "",
    "### 📊 Monitoring & Status",
    "- `/status` → Cek kondisi koneksi WhatsApp, user aktif, & subscribers",
    "- `/env` → Cek environment dan config WhatsApp aktif (`production` / `development`)",
    "- `/groups [keyword]` → Cari/lihat daftar grup WhatsApp dari session aktif",
    "- `/private [keyword]` → Cari/lihat daftar kontak private chat WhatsApp",
    "",
    "### 📂 Group & Whitelist Management",
    "- `/register` → Request whitelist chat Telegram ini",
    "- `/register <chat_id> [label]` → Admin approve whitelist Telegram",
    "- `/whitelist` → Admin lihat daftar whitelist Telegram",
    "- `/change_env production` → Pakai `config/whatsapp.json`",
    "- `/change_env development` → Pakai `config/whatsapp-test.json`",
    "",
    "### 📤 Mode Pengiriman Excel Tiket",
    "- **Tanpa Caption / `.import` / `.send`** → Pengiriman tiket normal ke grup target",
    "- `.update` → Kirim detail tiket eskalasi saja ke grup target",
    "- `.summary` → Kirim ringkasan & Excel balasan saja ke pengirim",
    "- `.reminder` → Kirim reminder semua tiket yang belum resolve",
    "- `.special` → Kirim ulang seluruh tiket valid (bypass cek duplikat sent_tickets)",
    "",
    "---",
    "📝 **Catatan Alur:**",
    "- Sebelum upload file Excel di grup, selalu pastikan session WhatsApp aktif (`/status`).",
    "- Sesi WhatsApp yang sudah login tersimpan aman dan tidak hilang kecuali di-logout atau diketik `/delete_session`.",
  ].join("\n");
}

function formatStartMessage() {
  return [
    "👋 **Selamat Datang di CCM Ticket Bot!**",
    "",
    "🤖 **CCM Ticket Bot** adalah sistem otomatisasi penanganan & eskalasi tiket Customer Complaint Management (CCM/Remedy) Telkomsel Region Sumbagut.",
    "",
    "🚀 **Fitur Utama Bot:**",
    "✅ **Automatic Routing & Escalation**: Memproses file Excel tiket dan meneruskannya secara otomatis ke grup WhatsApp SQA & NOP sesuai wilayah/cluster.",
    "✅ **Auto Mention & Tagging**: Tagging otomatis JID WhatsApp PIC CCM, PIC SQA, dan PIC NOP.",
    "✅ **Smart ReOpen & SLA Tracker**: Mendeteksi kenaikan count ReOpen dan menghitung durasi keterlambatan SLA (`Out Xd Xh Xm`).",
    "✅ **Fleksibilitas Mode Pengiriman**: Mendukung mode `.import` (full flow), `.update` (detail eskalasi saja), `.summary` (report saja), dan `.reminder` (reminder unresolved).",
    "✅ **WhatsApp Session Management**: Kelola sesi login/logout WhatsApp dengan aman via Telegram Command Center.",
    "",
    "--------------------------------------------------",
    "👉 Ketik `/help` untuk melihat panduan lengkap cara penggunaan dan daftar command bot.",
  ].join("\n");
}

function formatStatus(whatsappStatus) {
  const activeSession = whatsappStatus.active_session;
  return [
    "📊 **Bot Status**",
    "",
    `🟢 WhatsApp Running: ${whatsappStatus.running ? "✅ YES" : "❌ NO"}`,
    `👤 WhatsApp User: ${whatsappStatus.user?.id || whatsappStatus.user?.name || "-"}`,
    `📱 Active Session: ${activeSession ? `${activeSession.label} (${activeSession.phone})` : "-"}`,
    `📂 Auth Directory: ${whatsappStatus.authDir || "-"}`,
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

  let lastResult = null;
  for (const [index, chunk] of chunks.entries()) {
    const message = createTelegramRichMessage(chunk, options);
    lastResult = await sendMessage(chatId, message.text, message.options);
    logger.info("Telegram rich message chunk sent", {
      chatId,
      chunk: index + 1,
      chunks: chunks.length,
      length: message.text.length,
    });
  }

  return lastResult;
}

async function editRichMessage(editMessageText, chatId, messageId, text, options = {}) {
  if (!editMessageText || !messageId) {
    return null;
  }

  const message = createTelegramRichMessage(text, options);
  try {
    return await editMessageText(chatId, messageId, message.text, message.options);
  } catch (error) {
    logger.warn("Telegram editRichMessage failed, ignored", {
      chatId,
      messageId,
      error: error.message,
    });
    return null;
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

async function sendTelegramCommandError(sendMessage, chatId, command, error) {
  logger.error("Telegram command failed", {
    chatId,
    command,
    message: error.message,
    stack: error.stack,
  });
  await sendRichMessage(
    sendMessage,
    chatId,
    [
      "❌ **Command gagal diproses**",
      "",
      `📝 Command: \`${command}\``,
      `🛑 Error: \`${error.message}\``,
      "",
      "👉 Cek log container jika error masih berulang.",
    ].join("\n"),
  );
}

// semua command operasional diarahkan ke Telegram agar WhatsApp fokus menerima Excel dan kirim tiket.
export function createTelegramCommandHandler({ config, whatsappSession }) {
  return async function handleTelegramUpdate(
    update,
    { downloadFile, sendDocument, sendMessage, editMessageText },
  ) {
    const chatId = getChatId(update);
    const chat = getChat(update);
    const from = getFrom(update);
    const document = getDocument(update);
    const text = getMessageText(update);
    const caption = getMessageCaption(update);

    if (chatId && document) {
      const importOptions = getTelegramDocumentImportOptions(caption);
      const admin = isAdminChat(chatId, config);
      const accessDecision = await getTelegramAccessDecision(chatId, { admin });
      logger.info("Incoming Telegram document", {
        chatId,
        fileName: document.file_name,
        mimeType: document.mime_type,
        caption,
        importOptions,
        accessDecision,
      });

      if (!accessDecision.allowed) {
        await sendRichMessage(
          sendMessage,
          chatId,
          formatAccessDeniedMessage(chatId, accessDecision),
        );
        return;
      }

      if (!importOptions.supported) {
        logger.warn("Telegram document rejected: unsupported caption command", {
          chatId,
          fileName: document.file_name,
          caption,
          command: importOptions.command,
        });
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "❓ **Command Caption Tidak Dikenal**",
            "",
            `⚙️ Caption yang diterima: \`${importOptions.command || "-"}\``,
            "",
            "➡️ Flow normal: gunakan caption `.import` atau `.send`.",
            "📌 Update tiket saja: gunakan caption `.update`.",
            "📊 Summary saja: gunakan caption `.summary`.",
            "⏰ Reminder saja: gunakan caption `.reminder`.",
            "⚡ Kirim ulang tiket (bypass duplikat): gunakan caption `.special`.",
            "",
            "---",
            "ℹ️ File tanpa caption command akan diabaikan.",
          ].join("\n"),
        );
        return;
      }
      if (!isSupportedTelegramExcelFile(document)) {
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "⚠️ **Format File Tidak Didukung**",
            "",
            `📄 File: \`${document.file_name || "-"}\``,
            "📌 Kirim file spreadsheet berformat `.xlsx` (Excel OpenXML).",
          ].join("\n"),
        );
        return;
      }

      try {
        await whatsappSession.ensureReady(chatId, { interactive: true });
      } catch (error) {
        logger.warn("Telegram Excel rejected: WhatsApp session is not ready", {
          chatId,
          fileName: document.file_name,
          message: error.message,
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

      const statusMsg = await sendRichMessage(
        sendMessage,
        chatId,
        importOptions.specialMode
          ? [
              "📂 **File Excel Diterima (Mode .special)**",
              "",
              "⏳ Mengunduh dan membaca file Excel...",
              "⚡ Seluruh tiket valid akan dikirim ulang dan riwayat sent_tickets diperbarui...",
              `📄 File Name: \`${document.file_name || "-"}\``,
            ].join("\n")
          : importOptions.reminderMode
          ? [
              "📂 **File Excel Diterima (Mode .reminder)**",
              "",
              "⏳ Mengunduh dan membaca file Excel...",
              "📱 Tiket SQA dikirim via JAPRI ke PIC CCM, tiket NOP ke grup NOP...",
              `📄 File Name: \`${document.file_name || "-"}\``,
            ].join("\n")
          : importOptions.summaryOnlyMode
            ? [
                "📂 **File Excel Diterima (Mode .summary)**",
                "",
                "⏳ Mengunduh dan membaca file Excel...",
                `📄 File Name: \`${document.file_name || "-"}\``,
              ].join("\n")
            : importOptions.ticketOnlyMode
              ? [
                  "📂 **File Excel Diterima (Mode .update)**",
                  "",
                  "⏳ Mengunduh dan membaca file Excel...",
                  "🚫 Salam pembuka, Excel target, dan reminder summary akan dilewati.",
                  `📄 File Name: \`${document.file_name || "-"}\``,
                ].join("\n")
              : [
                  "📂 **File Excel Diterima**",
                  "",
                  "⏳ Mengunduh dan membaca file Excel...",
                  `📄 File Name: \`${document.file_name || "-"}\``,
                ].join("\n"),
      );

      const statusMsgId = statusMsg?.message_id;

      try {
        const buffer = await downloadFile(document.file_id);
        logger.info("Starting Telegram ticket Excel process", {
          chatId,
          fileName: document.file_name,
          bytes: buffer.length,
          ticketOnlyMode: importOptions.ticketOnlyMode,
          summaryOnlyMode: importOptions.summaryOnlyMode,
        });
        const result = await processTicketExcel(buffer);
        logger.info("Telegram ticket Excel process completed", {
          chatId,
          total: result.total_rows,
          valid: result.valid_count || 0,
          skipped: result.skipped_count || 0,
          ticketOnlyMode: importOptions.ticketOnlyMode,
          summaryOnlyMode: importOptions.summaryOnlyMode,
        });

        if (statusMsgId && editMessageText) {
          await editRichMessage(
            editMessageText,
            chatId,
            statusMsgId,
            [
              "📂 **File Excel Selesai Diparsing**",
              "",
              `📄 File: \`${document.file_name || "-"}\``,
              `📊 Data: **${result.total_rows} total** | **${result.valid_count || 0} valid** | **${result.skipped_count || 0} skip**`,
              "",
              "⬇️ Laporan & progres pengiriman tiket ditampilkan di bawah.",
            ].join("\n"),
          );
        }

        const adapter = createTelegramWhatsAppAdapter({
          ensureWhatsAppReady: (options) =>
            whatsappSession.ensureReady(chatId, options),
          getWhatsAppSocket: () => whatsappSession.getSocket(),
          sourceChatId: chatId,
          sendDocument,
          sendMessage,
          editMessageText,
          initialProgressMessageId: null,
        });

        sendImportResult(adapter, adapter.sourceJid, result, importOptions).catch(
          (error) => {
            logger.error("Failed to deliver ticket results in background", error);
            sendRichMessage(
              sendMessage,
              chatId,
              [
                "❌ **Gagal Mengirim Tiket ke WhatsApp**",
                "",
                `🛑 Error: \`${error.message}\``,
              ].join("\n"),
            ).catch(() => {});
          },
        );
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
            "👉 Pastikan format kolom file sesuai template CCM.",
          ].join("\n"),
        );
      }
      return;
    }

    const admin = isAdminChat(chatId, config);
    const accessDecision = chatId
      ? await getTelegramAccessDecision(chatId, { admin })
      : { allowed: false };

    if (chatId && text && !text.startsWith("/") && accessDecision.allowed) {
      const pendingLoginResult =
        await whatsappSession.completePendingLoginName(chatId, text);
      if (pendingLoginResult) {
        await sendRichMessage(sendMessage, chatId, pendingLoginResult);
        return;
      }

      const pendingSwitchResult =
        await whatsappSession.completePendingSessionSwitch?.(chatId, text);
      if (pendingSwitchResult) {
        await sendRichMessage(sendMessage, chatId, pendingSwitchResult);
        return;
      }

      const pendingReauthResult =
        await whatsappSession.completePendingExpiredSessionReauth?.(chatId, text);
      if (pendingReauthResult) {
        await sendRichMessage(sendMessage, chatId, pendingReauthResult);
        return;
      }
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

    if (!accessDecision.allowed) {
      logger.warn("Telegram command rejected: unauthorized chat", {
        chatId,
        command,
        reason: accessDecision.reason,
        sourceType: accessDecision.source_type,
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
          `🔎 Reason: \`${accessDecision.reason}\``,
          "⚠️ Status: **Belum whitelist Telegram**",
          "",
          "👉 Kirim `/register` untuk minta approval admin.",
        ].join("\n"),
      );
      return;
    }

    if (command === "/start") {
      await sendRichMessage(sendMessage, chatId, formatStartMessage());
      return;
    }

    if (command === "/help") {
      const isGroup =
        String(chatId).startsWith("-") ||
        chat?.type === "group" ||
        chat?.type === "supergroup";
      const helpText = isGroup
        ? formatTelegramGroupHelp()
        : formatTelegramPersonalHelp();
      await sendRichMessage(sendMessage, chatId, helpText);
      return;
    }

    if (
      !admin &&
      (isAdminOnlyCommand(command) ||
        isAdminOnlyRegisterCommand(command, argument))
    ) {
      logger.warn("Telegram admin command rejected from non-admin chat", {
        chatId,
        command,
        accessReason: accessDecision.reason,
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

    if (command === "/env") {
      await sendRichMessage(sendMessage, chatId, formatEnvironmentStatus());
      return;
    }

    if (command === "/change_env") {
      if (!argument) {
        await sendRichMessage(
          sendMessage,
          chatId,
          formatEnvironmentChangeUsage(),
        );
        return;
      }

      const result = changeRuntimeEnvironment(argument, { updatedBy: chatId });
      await sendRichMessage(
        sendMessage,
        chatId,
        formatEnvironmentChangeResult(result),
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

    if (command === "/sessions") {
      try {
        await sendRichMessage(
          sendMessage,
          chatId,
          await whatsappSession.listSessions(),
        );
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/login") {
      try {
        const result = await whatsappSession.login(chatId, argument);
        await sendRichMessage(sendMessage, chatId, result);
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/stop") {
      try {
        const result = await whatsappSession.stop(argument);
        await sendRichMessage(sendMessage, chatId, result);
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/logout") {
      try {
        const result = await whatsappSession.logout(argument);
        await sendRichMessage(sendMessage, chatId, result);
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/delete_session") {
      try {
        const result = await whatsappSession.deleteSession(argument);
        await sendRichMessage(sendMessage, chatId, result);
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/cancel" || command === ".cancel") {
      try {
        const qrResult = await whatsappSession.cancelQr(chatId);
        cancelActiveDelivery("Telegram /cancel command");

        const isQrCancelled = qrResult && qrResult.includes("Dibatalkan");
        const cancelStatusLines = [
          "🛑 **Pembatalan Proses Selesai**",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          "✅ **Pengiriman Tiket**: Seluruh antrian & pengiriman tiket aktif berhasil dihentikan.",
          "✅ **Sesi Login QR**: " + (isQrCancelled ? "Sesi scan QR dibatalkan." : "Tidak ada sesi QR aktif."),
        ];

        await sendRichMessage(sendMessage, chatId, cancelStatusLines.join("\n"));
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/groups") {
      try {
        await sendRichMessage(
          sendMessage,
          chatId,
          await formatWhatsAppGroupsCommand(argument),
        );
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
      return;
    }

    if (command === "/private") {
      try {
        await sendRichMessage(
          sendMessage,
          chatId,
          formatWhatsAppPrivateCommand(argument),
        );
      } catch (error) {
        await sendTelegramCommandError(sendMessage, chatId, command, error);
      }
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
