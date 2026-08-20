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
  resolveTelegramTargetChatId,
} from "../services/telegramAccessService.js";
import {
  getGroupKeyByJid,
  getMentionNameByJid,
  replaceJidMentionsWithLabels,
} from "../config/appConfig.js";
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

  const { command, argument } = parseCommand(text);
  const words = text.toLowerCase().split(/\s+/);
  const manualMode = words.includes("manual");

  const baseCommand = command.toLowerCase();
  const normalMode = [".import", ".send", "/import", "/send", ".manual", "/manual"].includes(baseCommand);
  const ticketOnlyMode = [".update", "/update"].includes(baseCommand);
  const summaryOnlyMode = [".summary", "/summary"].includes(baseCommand);
  const reminderMode = [".reminder", "/reminder"].includes(baseCommand);
  const specialMode = [".special", "/special"].includes(baseCommand);

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
    manualMode: manualMode || baseCommand === ".manual" || baseCommand === "/manual",
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
  manualMode = false,
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
          const cleanText = replaceJidMentionsWithLabels(payload.text);
          if (payload.isProgress && editMessageText) {
            if (progressMessageId) {
              await editRichMessage(
                editMessageText,
                sourceChatId,
                progressMessageId,
                cleanText,
              );
              return { message_id: progressMessageId };
            }
            const sent = await sendRichMessage(
              sendMessage,
              sourceChatId,
              cleanText,
            );
            progressMessageId = sent?.message_id || null;
            return sent;
          }

          return await sendRichMessage(sendMessage, sourceChatId, cleanText);
        }

        logger.warn("Telegram source payload skipped: unsupported payload", {
          sourceChatId,
          keys: Object.keys(payload || {}),
        });
        return;
      }

      // Jika dalam manualMode, jangan kirim ke WhatsApp, melainkan kirim ke Telegram!
      if (manualMode) {
        const groupKey = getGroupKeyByJid(jid);
        const mentionLabel = !groupKey ? getMentionNameByJid(jid) : null;
        const targetChatId = groupKey
          ? await resolveTelegramTargetChatId(groupKey)
          : null;

        const destinationChatId = targetChatId || sourceChatId;
        const targetLabel = groupKey || mentionLabel || jid;

        logger.info("Routing payload in Telegram manual mode", {
          sourceChatId,
          destinationChatId,
          targetJid: jid,
          groupKey,
          targetLabel,
          hasConfiguredGroup: Boolean(targetChatId),
        });

        const sendPayloadToChat = async (chatId, isFallback = false) => {
          if (payload?.document) {
            const cleanCaption = replaceJidMentionsWithLabels(
              payload.caption || "",
            );
            const docCaption = [
              !targetChatId || isFallback
                ? `📋 **[MANUAL FORWARD TO: ${targetLabel}]**\n`
                : "",
              cleanCaption,
            ]
              .filter(Boolean)
              .join("\n");

            await sendDocument(chatId, payload.document, {
              mimetype: payload.mimetype,
              fileName: payload.fileName,
              caption: docCaption,
            });
            return;
          }

          if (payload?.text) {
            const cleanText = replaceJidMentionsWithLabels(payload.text);
            const messageText = [
              isFallback
                ? `⚠️ **[Target Telegram: ${targetLabel} (${destinationChatId}) Gagal Terkirim: Diteruskan ke Sini]**\n`
                : "",
              !targetChatId || isFallback
                ? `📋 **[MANUAL FORWARD TO: ${targetLabel}]**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`
                : "",
              cleanText,
            ]
              .filter(Boolean)
              .join("");

            return await sendRichMessage(sendMessage, chatId, messageText);
          }
        };

        try {
          return await sendPayloadToChat(destinationChatId, false);
        } catch (error) {
          if (destinationChatId !== sourceChatId) {
            logger.warn(
              "Failed to send to Telegram target group, falling back to source chat",
              {
                destinationChatId,
                sourceChatId,
                error: error.message,
              },
            );
            return await sendPayloadToChat(sourceChatId, true);
          }
          throw error;
        }
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
  const message = String(error?.message || "");
  const statusCode =
    error?.output?.statusCode ||
    error?.data?.output?.statusCode ||
    error?.output?.payload?.statusCode;

  return (
    /connection closed|timed out|request time-out|socket closed|stream errored|network error|econnreset/i.test(
      message,
    ) ||
    statusCode === 408 ||
    statusCode === 503 ||
    statusCode === 515
  );
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
    "⚠️ **Cek Koneksi WhatsApp Bot:** Pastikan sesi WhatsApp aktif (`/status` / `/login`) jika tidak menggunakan mode manual.",
    "",
    "--------------------------------------------------",
    "",
    "📤 **Upload File Excel (`.xlsx`) dengan Caption:**",
    "• `.import` : Flow normal ke WhatsApp (tiket, Excel balasan, & summary).",
    "• `.update` : Kirim detail tiket eskalasi saja ke WhatsApp.",
    "• `.summary` : Kirim rekap summary & Excel balasan saja ke chat ini.",
    "• `.reminder` : Kirim reminder tiket unresolved.",
    "• `.special` : Force resend tiket (bypass database sent_tickets).",
    "• `... manual` : Tambahkan kata `manual` (misal: `.update manual`) untuk kirim ke Telegram target tanpa WhatsApp.",
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
    "🤖 **Admin Command Center (Personal Guide)**",
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
    "- `... manual` → Tambahkan `manual` di belakang command untuk routing via **Telegram Only** (tanpa WA)",
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
    "✅ **Auto Routing & Tagging**: Kirim tiket ke grup target SQA/NOP & auto-mention PIC.",
    "✅ **SLA & ReOpen Tracker**: Deteksi kenaikan ReOpen & durasi keterlambatan SLA.",
    "✅ **Multi Mode Pengiriman**: `.import`, `.update`, `.summary`, `.reminder`, `.special`.",
    "✅ **Mode Manual Telegram**: Tambahkan kata `manual` (contoh: `.update manual`) jika belum login WhatsApp untuk mengirim tiket langsung ke Telegram.",
    "",
    "👉 Ketik `/help` untuk panduan command lengkap.",
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

      if (!importOptions.manualMode) {
        try {
          await whatsappSession.ensureReady(chatId, { interactive: true });
        } catch (error) {
          logger.warn("Telegram Excel rejected: WhatsApp session is not ready", {
            chatId,
            fileName: document.file_name,
            message: error.message,
          });
          const baseCmd = importOptions.command || ".update";
          await sendRichMessage(
            sendMessage,
            chatId,
            [
              "⚠️ **WhatsApp Session Belum Terkait**",
              "",
              "📤 File sudah diterima, tetapi sesi WhatsApp bot belum terkait / aktif.",
              "",
              "👉 **Pilihan Solusi:**",
              "1. **Login WhatsApp**: Jalankan `/login` untuk mengaitkan sesi WhatsApp Anda.",
              `2. **Mode Manual**: Jalankan secara manual dengan caption \`${baseCmd} manual\` (contoh: \`.update manual\`) jika tidak memiliki sesi WhatsApp.`,
              "",
              "ℹ️ Ketik `/help` untuk info lengkapnya.",
            ].join("\n"),
          );
          return;
        }
      }

      const manualTag = importOptions.manualMode ? " (Mode Manual / Telegram Only)" : "";
      const statusMsg = await sendRichMessage(
        sendMessage,
        chatId,
        importOptions.specialMode
          ? [
              `📂 **File Excel Diterima (Mode .special${manualTag})**`,
              "",
              "⏳ Mengunduh dan membaca file Excel...",
              "⚡ Seluruh tiket valid akan dikirim ulang dan riwayat sent_tickets diperbarui...",
              `📄 File Name: \`${document.file_name || "-"}\``,
            ].join("\n")
          : importOptions.reminderMode
          ? [
              `📂 **File Excel Diterima (Mode .reminder${manualTag})**`,
              "",
              "⏳ Mengunduh dan membaca file Excel...",
              importOptions.manualMode
                ? "📱 Seluruh tiket dan reminder diteruskan ke Telegram untuk diteruskan manual..."
                : "📱 Tiket SQA dikirim via JAPRI ke PIC CCM, tiket NOP ke grup NOP...",
              `📄 File Name: \`${document.file_name || "-"}\``,
            ].join("\n")
          : importOptions.summaryOnlyMode
            ? [
                `📂 **File Excel Diterima (Mode .summary${manualTag})**`,
                "",
                "⏳ Mengunduh dan membaca file Excel...",
                `📄 File Name: \`${document.file_name || "-"}\``,
              ].join("\n")
            : importOptions.ticketOnlyMode
              ? [
                  `📂 **File Excel Diterima (Mode .update${manualTag})**`,
                  "",
                  "⏳ Mengunduh dan membaca file Excel...",
                  "🚫 Salam pembuka, Excel target, dan reminder summary akan dilewati.",
                  `📄 File Name: \`${document.file_name || "-"}\``,
                ].join("\n")
              : [
                  `📂 **File Excel Diterima${manualTag}**`,
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
          manualMode: importOptions.manualMode,
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
