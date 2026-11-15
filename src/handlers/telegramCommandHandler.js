import { createLogger } from "../utils/logger.js";
import {
  createTelegramRichMessage,
  splitTelegramMessageText,
} from "../utils/telegramFormat.js";
import { INDONESIAN_MONTHS_MAP as INDONESIAN_MONTHS } from "../utils/dateTime.js";
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
import {
  processTicketExcel,
  parseWorkbook,
  processTicketRows,
  shortenNopName,
  normalizeSlaStatus,
} from "../services/ticketImportService.js";
import { isDatabaseConfigured } from "../services/databaseService.js";
import {
  batchUpsertMasterTickets,
  isAllowedInjectAssignGroup,
} from "../services/inapTicketStore.js";
import { generateSiteRepetitiveAlert } from "../services/siteRepetitiveService.js";
import { formatAsciiTable, createCodeBlock } from "../utils/asciiTable.js";
import {
  changeRuntimeEnvironment,
  formatEnvironmentChangeResult,
  formatEnvironmentChangeUsage,
  formatEnvironmentStatus,
} from "../services/runtimeEnvironmentService.js";
import { isMeaningfulPayload } from "../utils/text.js";

const logger = createLogger("telegramCommandHandler");
const TELEGRAM_SOURCE_PREFIX = "telegram:";

const MONTH_FILTER_LOOKUP = {
  januari: "01",
  jan: "01",
  "01": "01",
  "1": "01",
  februari: "02",
  feb: "02",
  "02": "02",
  "2": "02",
  maret: "03",
  mar: "03",
  "03": "03",
  "3": "03",
  april: "04",
  apr: "04",
  "04": "04",
  "4": "04",
  mei: "05",
  "05": "05",
  "5": "05",
  juni: "06",
  jun: "06",
  "06": "06",
  "6": "06",
  juli: "07",
  jul: "07",
  "07": "07",
  "7": "07",
  agustus: "08",
  agu: "08",
  agt: "08",
  "08": "08",
  "8": "08",
  september: "09",
  sep: "09",
  "09": "09",
  "9": "09",
  oktober: "10",
  okt: "10",
  "10": "10",
  november: "11",
  nov: "11",
  "11": "11",
  desember: "12",
  des: "12",
  "12": "12",
};

export function extractTicketSummaryRows(rawRows, processedResult = null) {
  const processedMap = new Map();
  if (processedResult?.valid_tickets) {
    for (const t of processedResult.valid_tickets) {
      if (t.order_id) processedMap.set(t.order_id, t);
    }
  }

  const items = [];
  for (const row of rawRows || []) {
    const orderId = String(row["Order ID"] || row.order_id || "").trim();
    if (!orderId || orderId === "-") continue;

    const matched = processedMap.get(orderId);

    const city =
      matched?.city ||
      row["City"] ||
      row["Kabupaten/Kota(Create Ticket)"] ||
      row["Kabupaten/Kota"] ||
      row.city ||
      "-";

    const clusterArea =
      matched?.cluster_area ||
      shortenNopName(
        row["Cluster Area"] ||
          row["Assign to L2(L2 Assign)"] ||
          row["Assignment Group"] ||
          row.cluster_area ||
          "-",
      );

    const rawSla = String(
      row["SLA Status"] ||
        row["Sla Status"] ||
        row["(L1 Assign_sla)"] ||
        "",
    ).trim();

    const matchedSla =
      matched?.sla_status &&
      matched.sla_status !== "UNKNOWN" &&
      matched.sla_status !== "-"
        ? matched.sla_status
        : "";

    const slaStatus =
      matchedSla ||
      (rawSla ? normalizeSlaStatus(rawSla) : "") ||
      "-";

    const pic =
      matched?.pic ||
      row["PIC"] ||
      row["Assign Personal(L2 Assign)"] ||
      row.pic ||
      "-";

    const siteId =
      matched?.site_id ||
      row["Site ID 1"] ||
      row["site_id1(L1 Assign)"] ||
      row["Site ID"] ||
      row.site_id ||
      "-";

    const createTime = String(row["Create Time"] || row.create_time || "").trim();

    let year = "";
    let month = "";
    const idMatch = orderId.match(/^CC-(\d{4})(\d{2})/i);
    if (idMatch) {
      year = idMatch[1];
      month = idMatch[2];
    } else if (createTime) {
      const dt = new Date(createTime);
      if (!isNaN(dt.getTime())) {
        year = String(dt.getFullYear());
        month = String(dt.getMonth() + 1).padStart(2, "0");
      }
    }

    items.push({
      order_id: orderId,
      city,
      cluster_area: clusterArea,
      sla_status: slaStatus,
      pic,
      site_id: siteId,
      create_time: createTime,
      year: year || "2026",
      month: month || "00",
      monthKey: `${year || "2026"}-${month || "00"}`,
      monthLabel: `${INDONESIAN_MONTHS[month] || "Bulan Lainnya"} ${year || "2026"}`,
    });
  }

  items.sort((a, b) => a.order_id.localeCompare(b.order_id));
  return items;
}

export function formatInjectMonthSummaryMessages(summaryRows, options = {}) {
  const filterKey = options.monthFilter ? String(options.monthFilter).toLowerCase().trim() : "";
  const monthFilter = filterKey ? MONTH_FILTER_LOOKUP[filterKey] : null;

  let rows = summaryRows;
  if (monthFilter) {
    rows = rows.filter((r) => r.month === monthFilter);
  }

  const monthGroups = new Map();
  for (const row of rows) {
    const key = row.monthKey;
    if (!monthGroups.has(key)) {
      monthGroups.set(key, {
        label: row.monthLabel,
        month: row.month,
        year: row.year,
        rows: [],
      });
    }
    monthGroups.get(key).rows.push(row);
  }

  const sortedKeys = [...monthGroups.keys()].sort();

  const columns = [
    { key: "order_id", header: "Order ID", minWidth: 20, maxWidth: 22 },
    { key: "city", header: "City", minWidth: 12, maxWidth: 19 },
    { key: "cluster_area", header: "Cluster Area", minWidth: 14, maxWidth: 22 },
    { key: "sla_status", header: "SLA Status", minWidth: 10, maxWidth: 10 },
    { key: "pic", header: "PIC", minWidth: 12, maxWidth: 26 },
    { key: "site_id", header: "Site ID", minWidth: 7, maxWidth: 9 },
  ];

  const messages = [];
  const CHUNK_SIZE = 20;
  const MAX_CHUNKS_PER_MONTH = options.maxChunksPerMonth ?? 5;
  const MAX_TOTAL_MESSAGES = options.maxTotalMessages ?? 10;

  for (const key of sortedKeys) {
    if (messages.length >= MAX_TOTAL_MESSAGES) {
      break;
    }
    const group = monthGroups.get(key);
    group.rows.sort((a, b) => a.order_id.localeCompare(b.order_id));

    const totalInMonth = group.rows.length;
    const allChunks = [];
    for (let i = 0; i < totalInMonth; i += CHUNK_SIZE) {
      allChunks.push(group.rows.slice(i, i + CHUNK_SIZE));
    }

    const previewChunks = allChunks.slice(0, MAX_CHUNKS_PER_MONTH);

    previewChunks.forEach((chunkRows, chunkIdx) => {
      if (messages.length >= MAX_TOTAL_MESSAGES) return;
      const table = formatAsciiTable(columns, chunkRows);
      const partTag =
        allChunks.length > 1
          ? ` (Bagian ${chunkIdx + 1}/${allChunks.length} - ${chunkRows.length} Tiket)`
          : ` (${totalInMonth} Tiket)`;

      messages.push(
        [
          `📅 **Bulan: ${group.label}${partTag}**`,
          createCodeBlock(table),
        ].join("\n"),
      );
    });

    if (allChunks.length > MAX_CHUNKS_PER_MONTH) {
      const shownCount = previewChunks.reduce((acc, c) => acc + c.length, 0);
      const remaining = totalInMonth - shownCount;
      messages.push(
        `ℹ️ *Tabel preview Bulan ${group.label} dibatasi hingga bagian ${MAX_CHUNKS_PER_MONTH}/${allChunks.length} (${shownCount} tiket).* Sisa ${remaining} tiket lainnya tetap tersimpan lengkap di database PostgreSQL.`,
      );
    }
  }

  return messages;
}

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
  const injectMode = [".inject", "/inject"].includes(baseCommand);

  return {
    command,
    argument: argument || "",
    supported:
      normalMode ||
      ticketOnlyMode ||
      summaryOnlyMode ||
      reminderMode ||
      specialMode ||
      injectMode,
    missingCommand: false,
    ticketOnlyMode,
    summaryOnlyMode,
    reminderMode,
    specialMode,
    injectMode,
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

export function createTelegramWhatsAppAdapter({
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
    async sendPresenceUpdate(presence, jid) {
      if (manualMode || String(jid).startsWith("manual:")) {
        return;
      }
      try {
        const whatsappSock =
          (await ensureWhatsAppReady?.()) || getWhatsAppSocket?.();
        if (whatsappSock?.sendPresenceUpdate) {
          await whatsappSock.sendPresenceUpdate(presence, jid);
        }
      } catch (error) {
        logger.debug("Failed to delegate presence update to WhatsApp socket", {
          presence,
          jid,
          error: error.message,
        });
      }
    },
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

      // Jika dalam manualMode atau JID belum dikonfigurasi di WhatsApp, kirim ke Telegram!
      if (manualMode || String(jid).startsWith("manual:")) {
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

      if (!isMeaningfulPayload(payload)) {
        logger.warn("Adapter prevented sending empty or letterless message to WhatsApp", {
          targetJid: jid,
          payloadType: typeof payload,
          payloadKeys: Object.keys(payload || {}),
          textContent: typeof payload === "string" ? payload : payload?.text,
        });
        return null;
      }

      try {
        return await whatsappSock.sendMessage(jid, payload);
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

        return await latestSock.sendMessage(jid, payload);
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
  return [
    "/logout",
    "/delete_session",
    "/whitelist",
    "/change_env",
    "/poll",
    "/autopoll",
    "/fetch",
    "/wperf",
    "/update_wperf",
  ].includes(command);
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
    "• `.reminder` : Kirim reminder tiket unresolved (SQA via JAPRI, NOP & Site Visit ke grup).",
    "• `.special` : Force resend tiket (bypass database sent_tickets).",
    "• `... manual` : Tambahkan kata `manual` (misal: `.update manual`) untuk kirim ke Telegram target tanpa WhatsApp.",
    "",
    "--------------------------------------------------",
    "",
    "📊 **Fitur Utama Bot:**",
    "✅ **Auto Routing SQA & NOP**: Kirim tiket ke grup target SQA & NOP berdasarkan Region/Cluster.",
    "✅ **Tiket Repetitif & Site Visit**: Otomatis routing tiket ReOpen ≥ 3 ke grup **SITE VISIT** & tag PIC TS wilayah (Medan, Aceh, Binjai, Sidempuan, Siantar) + PIC SQA.",
    "✅ **Auto Tagging / Mention**: Tagging otomatis ke PIC CCM, PIC SQA, PIC NOP, & TS Site Visit.",
    "✅ **SLA & ReOpen Tracker**: Deteksi kenaikan ReOpen & kalkulasi durasi keterlambatan SLA (Out SLA).",
    "✅ **Rekap & Report Filter Excel**: Otomatis generate Excel balasan & laporan pemrosesan tiket.",
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
    "- `/remind_inject` → Trigger manual pesan pengingat penutupan report (.inject) 17:00 WIB",
    "- `/wperf` → Trigger manual pembaruan & sinkronisasi data WPERF (Refresh MV & Leapdate)",
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
    "### 🔁 Fitur Eskalasi Tiket Repetitif (Site Visit)",
    "- Tiket ReOpen = 3: Tetap dikirim ke SQA + dikirim khusus ke grup **SITE VISIT**.",
    "- Tiket ReOpen > 3: Tidak lagi dikirim ke SQA, melainkan dialihkan khusus ke grup **SITE VISIT**.",
    "- Auto-tag dual PIC: Tag PIC TS wilayah kerja (Medan, Aceh, Binjai, Sidempuan, Siantar) dan PIC SQA.",
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
    "✅ **Auto Routing & Tagging**: Kirim tiket ke grup target SQA/NOP & auto-mention PIC terkait.",
    "✅ **Tiket Repetitif (>3 ReOpen)**: Otomatis dialihkan ke grup **SITE VISIT** dan tag PIC TS (Medan, Aceh, Binjai, Sidempuan, Siantar) & PIC SQA.",
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
export function createTelegramCommandHandler({
  config,
  whatsappSession,
  ticketPolling,
  dailyReminder,
  wperfSync,
}) {
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
            "💾 Injeksi data master ke DB: gunakan caption `.inject`.",
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

      if (!importOptions.manualMode && !importOptions.injectMode) {
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
          : importOptions.injectMode
            ? [
                "📂 **File Excel Diterima (Mode .inject Database)**",
                "",
                "⏳ Mengunduh dan membaca 208 kolom file Excel...",
                "💾 Memasukkan data master tiket ke PostgreSQL...",
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
          injectMode: importOptions.injectMode,
        });

        if (importOptions.injectMode) {
          logger.info("Processing Excel in .inject mode to PostgreSQL", {
            chatId,
            fileName: document.file_name,
            bytes: buffer.length,
            monthFilter: importOptions.argument,
          });
          const rawRows = await parseWorkbook(buffer);
          // Filter hanya 8 grup L2 Sumbagut yang valid (tidak NULL dan bukan grup luar seperti RTP)
          const rows = rawRows.filter((r) =>
            isAllowedInjectAssignGroup(
              r["Assign to L2(L2 Assign)"] ||
                r.assign_to_l2_l2_assign ||
                r.assignment_group ||
                r["assignment_group"],
            ),
          );
          const skippedCount = rawRows.length - rows.length;

          const upsertResult = await batchUpsertMasterTickets(rows, {
            filterAllowedL2Groups: true,
          });

          // Normalisasi baris dan kelompokkan per bulan untuk tabel summary
          const processedResult = processTicketRows(rows);
          const summaryRows = extractTicketSummaryRows(rows, processedResult);
          const tableMessages = formatInjectMonthSummaryMessages(summaryRows, {
            monthFilter: importOptions.argument,
          });

          // Kirim tabel summary per bulan (diurutkan berdasarkan order id)
          try {
            for (const tableMsg of tableMessages) {
              await sendRichMessage(sendMessage, chatId, tableMsg);
              await new Promise((r) => setTimeout(r, 400));
            }
          } catch (tableErr) {
            logger.warn("Sending summary table preview hit Telegram limit or failed", {
              error: tableErr.message,
            });
            await sendRichMessage(
              sendMessage,
              chatId,
              `⚠️ Pengiriman tabel preview Telegram dihentikan karena batas rate limit: ${tableErr.message}.\nSeluruh data master tiket tetap berhasil tersimpan di database PostgreSQL.`,
            ).catch(() => {});
          }

          const report = [
            "✅ **Injeksi Data Master Tiket Berhasil**",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            `📄 **File Excel**         : \`${document.file_name || "-"}\``,
            `📊 **Total Baris File**    : **${rawRows.length} baris**`,
            `💾 **Tersimpan ke DB**    : **${upsertResult.processed} tiket**`,
            ...(skippedCount > 0
              ? [`⏭️ **Dilewati (Luar L2)**  : **${skippedCount} tiket**`]
              : []),
            `📁 **Tabel Target**       : \`SQA_SUMBAGUT.inap_ticketing_customer_complain\``,
            "",
            "ℹ️ Data telah tersimpan di PostgreSQL dan siap digunakan untuk verifikasi deduplikasi harian (.update).",
          ].join("\n");

          if (statusMsgId && editMessageText) {
            await editRichMessage(editMessageText, chatId, statusMsgId, report);
          } else {
            await sendRichMessage(sendMessage, chatId, report);
          }

          // Peringatan komplain repetitif site ID (hanya dikirimkan ke chat/grup pengirim)
          try {
            const siteRepetitiveAlert = await generateSiteRepetitiveAlert(
              rows,
              { referenceDate: new Date() },
            );
            if (siteRepetitiveAlert) {
              await sendRichMessage(
                sendMessage,
                chatId,
                siteRepetitiveAlert.text,
              );
            }
          } catch (siteRepErr) {
            logger.warn("Failed checking site repetitive complaints in .inject", {
              error: siteRepErr.message,
            });
          }

          return;
        }

        if (isDatabaseConfigured()) {
          parseWorkbook(buffer)
            .then((rows) => batchUpsertMasterTickets(rows, { filterAllowedL2Groups: true }))
            .catch((err) =>
              logger.warn("Background upsert to PostgreSQL failed during import", {
                error: err.message,
              }),
            );
        }

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

    if (command === "/poll" || command === "/autopoll" || command === "/fetch") {
      if (!ticketPolling) {
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "ℹ️ **Fitur Auto-Polling Database Belum Diaktifkan**",
            "",
            "Untuk mengaktifkan fitur pengecekan otomatis database ClickHouse:",
            "1. Atur `DB_POLL_ENABLED=true` di file `.env`.",
            "2. Lengkapi konfigurasi `DB_HOST`, `DB_USER`, `DB_PASSWORD`.",
            "3. Restart aplikasi bot.",
          ].join("\n"),
        );
        return;
      }

      const subCommand = String(argument || "").trim().toLowerCase();

      if (command === "/fetch" || subCommand === "now") {
        await sendRichMessage(
          sendMessage,
          chatId,
          "⏳ **Menjalankan Pengecekan Database Instan...**\nSedang memeriksa tiket L2 Assign running di ClickHouse...",
        );
        try {
          const pollResult = await ticketPolling.poll({ force: true });
          if (pollResult.status === "SUCCESS") {
            await sendRichMessage(
              sendMessage,
              chatId,
              `✅ **Pengecekan Instan Selesai**\n📦 Berhasil mengirim **${pollResult.newTickets} tiket baru** ke WhatsApp.`,
            );
          } else if (
            pollResult.status === "NO_ROWS" ||
            pollResult.status === "ALL_DUPLICATES" ||
            pollResult.status === "NO_VALID_TICKETS"
          ) {
            await sendRichMessage(
              sendMessage,
              chatId,
              "ℹ️ **Database Up-to-Date**\nTidak ada tiket baru yang perlu dikirim dari database saat ini.",
            );
          } else if (pollResult.status === "ALREADY_ACTIVE") {
            await sendRichMessage(
              sendMessage,
              chatId,
              "⏳ Siklus pengecekan database lain sedang berjalan, mohon tunggu sebentar.",
            );
          } else {
            await sendRichMessage(
              sendMessage,
              chatId,
              `⚠️ **Status Pengecekan**: \`${pollResult.status}\`${pollResult.error ? `\n🛑 Error: \`${pollResult.error}\`` : ""}`,
            );
          }
        } catch (pollErr) {
          await sendTelegramCommandError(sendMessage, chatId, command, pollErr);
        }
        return;
      }

      if (subCommand === "off" || subCommand === "pause" || subCommand === "stop") {
        ticketPolling.pause();
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "⏸️ **Auto-Polling Dijeda (Paused)**",
            "",
            "Pengecekan otomatis berkala ke database dihentikan sementara.",
            "👉 Ketik `/poll on` untuk mengaktifkan kembali.",
          ].join("\n"),
        );
        return;
      }

      if (subCommand === "on" || subCommand === "resume" || subCommand === "start") {
        ticketPolling.resume();
        await sendRichMessage(
          sendMessage,
          chatId,
          [
            "▶️ **Auto-Polling Diaktifkan (Active)**",
            "",
            "Pengecekan otomatis berkala ke database kembali aktif setiap 5 menit pada jam operasional (07:00 - 17:00 WIB).",
          ].join("\n"),
        );
        return;
      }

      // Default: /poll status
      try {
        const pollStatus = await ticketPolling.getStatus();
        const statusLines = [
          "📊 **Status Auto-Polling Database (ClickHouse)**",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          `⚙️ **Status Fitur**     : ${pollStatus.isPaused ? "⏸️ JEDA (PAUSED)" : pollStatus.isRunning ? "✅ AKTIF (RUNNING)" : "🛑 STOPPED"}`,
          `🕒 **Jam Kerja**        : **${pollStatus.workingHoursText}**`,
          `⏱️ **Sedang Jam Kerja** : ${pollStatus.inWorkingHours ? "✅ Ya" : "🌙 Di luar jam kerja (Sleep)"}`,
          `🔄 **Interval Polling** : **Setiap ${pollStatus.intervalMinutes} menit**`,
          "",
          `🗄️ **Koneksi Database** : ${pollStatus.dbConnected ? "🟢 Terhubung (Port 9443 HTTPS)" : `🔴 Gagal (${pollStatus.dbError || "Error"})`}`,
          `⏱️ **Cek Terakhir**      : \`${pollStatus.lastPollTime || "-"}\``,
          `📅 **Watermark DB**      : \`${pollStatus.lastWatermark || "-"}\``,
          `📦 **Terkirim Hari Ini** : **${pollStatus.totalSentToday} tiket**`,
        ];
        if (pollStatus.lastError) {
          statusLines.push("", `⚠️ **Error Terakhir**: \`${pollStatus.lastError}\``);
        }
        statusLines.push(
          "",
          "💡 **Perintah Kendali:**",
          "• `/poll now` : Tarik & kirim tiket baru instan detik ini",
          "• `/poll off` : Jeda pengecekan otomatis",
          "• `/poll on`  : Lanjutkan pengecekan otomatis",
        );
        await sendRichMessage(sendMessage, chatId, statusLines.join("\n"));
      } catch (err) {
        await sendTelegramCommandError(sendMessage, chatId, command, err);
      }
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

    if (command === "/wperf" || command === "/update_wperf") {
      if (!wperfSync) {
        await sendRichMessage(
          sendMessage,
          chatId,
          "⚠️ **Fitur Sinkronisasi WPERF Belum Diaktifkan**\nLayanan WPERF sync belum diinisialisasi.",
        );
        return;
      }

      if (wperfSync.isSyncRunning()) {
        await sendRichMessage(
          sendMessage,
          chatId,
          "⏳ **Pembaruan WPERF Sedang Berjalan**\nProses pembaruan data sedang berlangsung di latar belakang. Mohon tunggu laporan selesai.",
        );
        return;
      }

      wperfSync.executeManualSync(chatId).catch((error) => {
        logger.error("Manual WPERF sync failed", { error: error.message, chatId });
      });
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

    if (command === "/remind_inject" || command === "/reminder_inject") {
      try {
        if (!dailyReminder) {
          await sendRichMessage(
            sendMessage,
            chatId,
            "ℹ️ **Daily Reminder Service Belum Diaktifkan**",
          );
          return;
        }

        const isGroup = String(chatId).startsWith("-");
        const triggerResult = await dailyReminder.triggerManual(isGroup ? chatId : null);
        if (triggerResult.sent) {
          await sendRichMessage(
            sendMessage,
            chatId,
            [
              "✅ **Pesan Reminder Berhasil Dikirim**",
              "",
              `📢 Pesan pengingat penutupan report (.inject) berhasil dikirimkan ke **${triggerResult.sentTo.length} chat/grup**.`,
            ].join("\n"),
          );
        } else {
          await sendRichMessage(
            sendMessage,
            chatId,
            `⚠️ Gagal mengirim reminder: ${triggerResult.reason || "Tidak ada penerima terdaftar"}.`,
          );
        }
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
