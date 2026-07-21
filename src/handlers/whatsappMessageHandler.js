import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";

import {
  getTargetGroupKey,
  resolveTargetJid,
} from "../config/whatsappRouting.js";
import { getGroupConfig } from "../config/appConfig.js";
import { createLogger } from "../utils/logger.js";
import {
  getMessageSenderJid,
  isGroupJid,
  isPrivateJid,
  normalizeJid,
} from "../utils/jid.js";
import { cleanInlineText } from "../utils/text.js";
import { acquireProcessLock } from "../utils/processLock.js";
import { enqueueTicketMessage } from "../services/messageQueueService.js";
import { isAllowedBotAccess } from "../services/accessControlService.js";
import {
  createSentTicketPlan,
  formatSentTicketPlanReport,
  markTicketAsSent,
} from "../services/sentTicketService.js";
import {
  createFilteredTicketsExcel,
  formatEscalationMessagePayload,
  formatImportSummary,
  formatProcessingReport,
  formatReminderMessagePayload,
  formatTargetGroupOpeningMessage,
  formatUpdateTicketFileName,
  processTicketExcel,
} from "../services/ticketImportService.js";

const AUTH_DIR = process.env.WA_AUTH_DIR || "sessions/baileys";
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || "silent";
const UNAUTHORIZED_TEXT = "sorry, you are not in our system\nbye bye \u{1F44B}";
const MAX_COMMAND_RESULT = Number(process.env.BOT_COMMAND_RESULT_LIMIT || 10);
const MAX_MESSAGE_LENGTH = 3500;
const logger = createLogger("whatsappMessageHandler");
const groupIndex = new Map();
const privateIndex = new Map();
let reconnectTimer = null;
let releaseSessionLock = null;

// melepas lock session saat proses dihentikan normal dari terminal.
function bindSessionLockCleanup() {
  if (!releaseSessionLock || bindSessionLockCleanup.bound) {
    return;
  }

  bindSessionLockCleanup.bound = true;
  process.once("exit", () => releaseSessionLock?.());
  process.once("SIGINT", () => {
    releaseSessionLock?.();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    releaseSessionLock?.();
    process.exit(0);
  });
}

// membaca versi WhatsApp Web dari env jika fetchLatestBaileysVersion memberi versi yang tidak cocok.
function parseWaWebVersion(value) {
  const version = String(value || "")
    .split(".")
    .map((item) => Number(item.trim()));

  return version.length === 3 && version.every(Number.isInteger)
    ? version
    : null;
}

// mengambil object dokumen dari pesan WhatsApp biasa atau dokumen yang di-quote.
function getDocumentMessage(message) {
  logger.debug("Checking message document payload");
  return (
    message?.documentMessage ||
    message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage
  );
}

// mengambil teks pesan biasa/extended agar pesan non-dokumen bisa diabaikan jelas.
function getMessageText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  ).trim();
}

// memecah pesan command seperti "." atau ".help" agar bot bisa memberi respon teks.
function parseBotCommand(text) {
  const [command = "", ...parts] = String(text || "")
    .trim()
    .split(/\s+/);

  return {
    command: command.toLowerCase(),
    argument: parts.join(" ").trim(),
  };
}

// membaca caption command pada dokumen Excel; .update berarti hanya kirim detail tiket.
function getDocumentImportOptions(text) {
  if (!String(text || "").trim().startsWith(".")) {
    return {
      command: "",
      supported: true,
      ticketOnlyMode: false,
    };
  }

  const { command } = parseBotCommand(text);
  return {
    command,
    supported: command === ".update",
    ticketOnlyMode: command === ".update",
  };
}

// normalisasi keyword command agar pencarian grup/private tidak sensitif kapital.
function normalizeCommandKeyword(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// menyimpan metadata grup yang diketahui session agar command .groups bisa dicari cepat.
function upsertGroup(jid, data = {}) {
  const normalizedJid = normalizeJid(jid);
  if (!isGroupJid(normalizedJid)) {
    return;
  }

  groupIndex.set(normalizedJid, {
    jid: normalizedJid,
    name: cleanInlineText(
      data.subject || data.name || data.notify || normalizedJid,
    ),
  });
}

// menyimpan metadata private chat/kontak yang tersinkron atau pernah mengirim pesan ke bot.
function upsertPrivate(jid, data = {}) {
  const normalizedJid = normalizeJid(jid);
  if (!isPrivateJid(normalizedJid)) {
    return;
  }

  const existing = privateIndex.get(normalizedJid) || {};
  privateIndex.set(normalizedJid, {
    jid: normalizedJid,
    name: cleanInlineText(
      data.name ||
        data.notify ||
        data.verifiedName ||
        data.pushName ||
        existing.name ||
        normalizedJid,
    ),
  });
}

// mencocokkan keyword ke nama atau JID untuk command .groups/.private.
function matchesCommandSearch(item, keyword) {
  const normalizedKeyword = normalizeCommandKeyword(keyword);
  if (!normalizedKeyword) {
    return true;
  }

  return (
    normalizeCommandKeyword(item.name).includes(normalizedKeyword) ||
    normalizeCommandKeyword(item.jid).includes(normalizedKeyword)
  );
}

// format output JID sama seperti kebutuhan user, maksimal BOT_COMMAND_RESULT_LIMIT baris.
function formatJidList({ label, items, keyword }) {
  const matched = items
    .filter((item) => matchesCommandSearch(item, keyword))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = matched.slice(0, MAX_COMMAND_RESULT);

  if (shown.length === 0) {
    return `${label} (0 total, showing 0):${keyword ? `\nFilter: ${keyword}` : ""}\n\nTidak ada hasil.`;
  }

  return [
    `${label} (${matched.length} total, showing ${shown.length}):`,
    ...shown.map((item) => `- ${item.jid} - ${item.name}`),
  ].join("\n");
}

// memecah pesan panjang agar output command tetap terkirim jika hasil JID cukup banyak.
async function sendLongText(sock, jid, text) {
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    await sock.sendMessage(jid, {
      text: text.slice(index, index + MAX_MESSAGE_LENGTH),
    });
  }
}

// membuat pesan bantuan singkat saat user mengirim command "." atau ".help".
function formatCommandHelp({ sourceJid, senderJid, allowed }) {
  return [
    "CCM Ticket Bot",
    "",
    `Access: ${allowed ? "ALLOWED" : "DENIED"}`,
    `Source JID: ${sourceJid || "-"}`,
    `Sender JID: ${senderJid || "-"}`,
    "",
    "Command:",
    ".",
    ".help",
    ".status",
    ".groups",
    ".groups nop",
    ".private",
    ".private ferry",
    ".update + file Excel",
    "",
    "Import tiket:",
    "- Kirim file Excel .xlsx ke grup/private yang sudah di whitelist.",
    "- Caption .update pada file Excel: hanya kirim detail tiket tanpa salam, Excel target, dan reminder summary ke grup target.",
    "- Grup sumber harus ada di authorized_groups.",
    "- Private chat harus ada di authorized_users atau OWNER_JIDS.",
  ].join("\n");
}

// mengambil ulang daftar grup dari WhatsApp agar command .groups memakai data terbaru.
async function refreshGroups(sock) {
  logger.info("Refreshing group metadata for command");
  const groups = await sock.groupFetchAllParticipating();

  for (const [jid, metadata] of Object.entries(groups)) {
    upsertGroup(jid, metadata);
  }

  logger.info("Group metadata refreshed for command", {
    groups: groupIndex.size,
  });
}

// membuat output status singkat untuk memastikan bot hidup dan membaca index lokal.
function formatBotStatus({ sourceJid, senderJid, allowed }) {
  return [
    "CCM Ticket Bot Status",
    "",
    `Access: ${allowed ? "ALLOWED" : "DENIED"}`,
    `Source JID: ${sourceJid || "-"}`,
    `Sender JID: ${senderJid || "-"}`,
    `Indexed groups: ${groupIndex.size}`,
    `Indexed private chats: ${privateIndex.size}`,
    `Result limit: ${MAX_COMMAND_RESULT}`,
  ].join("\n");
}

// menangani command teks di bot utama agar user mendapat output WhatsApp dan log jelas.
async function handleBotCommand(sock, { sourceJid, senderJid, text }) {
  const { command, argument } = parseBotCommand(text);

  logger.info("Incoming bot command", {
    sourceJid,
    senderJid,
    command,
    argument,
  });

  if (
    ![".", ".help", ".status", ".groups", ".private", ".update"].includes(
      command,
    )
  ) {
    logger.warn("Bot command ignored: unsupported command", {
      sourceJid,
      senderJid,
      command,
    });
    await sock.sendMessage(sourceJid, {
      text: `Command tidak dikenal: ${command}\nKetik . untuk bantuan.`,
    });
    return;
  }

  const allowed = isAllowedBotAccess({ sourceJid, senderJid });
  logger.info("Bot command access checked", {
    sourceJid,
    senderJid,
    command,
    allowed,
  });

  if (command === "." || command === ".help") {
    await sock.sendMessage(sourceJid, {
      text: formatCommandHelp({ sourceJid, senderJid, allowed }),
    });
  }

  if (command === ".status") {
    await sock.sendMessage(sourceJid, {
      text: formatBotStatus({ sourceJid, senderJid, allowed }),
    });
  }

  if (command === ".update") {
    await sock.sendMessage(sourceJid, {
      text: [
        "Mode .update digunakan sebagai caption file Excel.",
        "",
        "Kirim file Excel dengan caption .update untuk hanya mengirim detail tiket ke grup target.",
        "Salam pembuka, Excel target, dan reminder summary tidak dikirim pada mode ini.",
      ].join("\n"),
    });
  }

  if (!allowed && [".groups", ".private"].includes(command)) {
    logger.warn("JID command rejected: source/sender is not allowed", {
      sourceJid,
      senderJid,
      command,
    });
    await sock.sendMessage(sourceJid, {
      text: UNAUTHORIZED_TEXT,
    });
    return;
  }

  if (command === ".groups") {
    await refreshGroups(sock);
    await sendLongText(
      sock,
      sourceJid,
      formatJidList({
        label: "WhatsApp groups",
        items: [...groupIndex.values()],
        keyword: argument,
      }),
    );
  }

  if (command === ".private") {
    await sendLongText(
      sock,
      sourceJid,
      formatJidList({
        label: "WhatsApp private chats",
        items: [...privateIndex.values()],
        keyword: argument,
      }),
    );
  }

  logger.info("Bot command response sent", {
    sourceJid,
    senderJid,
    command,
    allowed,
  });
}

// menghubungkan event Baileys ke index lokal untuk command .groups/.private.
function bindCommandIndexEvents(sock) {
  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of contacts) {
      upsertPrivate(contact.id, contact);
    }
    logger.info("Contacts indexed for command", {
      privateChats: privateIndex.size,
    });
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const chat of chats) {
      if (isGroupJid(chat.id)) {
        upsertGroup(chat.id, chat);
      } else {
        upsertPrivate(chat.id, chat);
      }
    }
    logger.info("Chats indexed for command", {
      groups: groupIndex.size,
      privateChats: privateIndex.size,
    });
  });

  sock.ev.on("messaging-history.set", ({ chats, contacts }) => {
    for (const contact of contacts || []) {
      upsertPrivate(contact.id, contact);
    }

    for (const chat of chats || []) {
      if (isGroupJid(chat.id)) {
        upsertGroup(chat.id, chat);
      } else {
        upsertPrivate(chat.id, chat);
      }
    }

    logger.info("Messaging history indexed for command", {
      groups: groupIndex.size,
      privateChats: privateIndex.size,
    });
  });
}

// memastikan bot hanya memproses file Excel .xlsx.
function isSupportedExcelFile(documentMessage) {
  const fileName = String(documentMessage?.fileName || "").toLowerCase();
  const mimetype = String(documentMessage?.mimetype || "").toLowerCase();
  logger.info("Validating incoming document format", { fileName, mimetype });

  return (
    fileName.endsWith(".xlsx") ||
    mimetype ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

// mengunduh dokumen WhatsApp menjadi Buffer agar bisa diparse sebagai Excel.
async function downloadDocumentBuffer(documentMessage) {
  logger.info("Downloading WhatsApp document", {
    fileName: documentMessage?.fileName,
    mimetype: documentMessage?.mimetype,
  });
  const stream = await downloadContentFromMessage(documentMessage, "document");
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  logger.info("Document downloaded", { bytes: buffer.length });
  return buffer;
}

// mengirim alert ke pengirim jika target group belum dikonfigurasi.
async function sendMissingTargetGroupAlert(sock, sourceJid, ticket) {
  const targetGroupKey = getTargetGroupKey(ticket);
  logger.warn("Escalation ticket skipped: target group JID is not configured", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    targetGroupKey,
    pic: ticket.pic,
  });
  await sock.sendMessage(sourceJid, {
    text: [
      "Alert konfigurasi target group kosong.",
      "",
      `Order ID: ${ticket.order_id || "-"}`,
      `Assignment: ${ticket.assignment_type || "-"}`,
      `Target group key: ${targetGroupKey || "-"}`,
      `PIC: ${ticket.pic || "-"}`,
      "",
      "Tiket ini tidak dikirim ke grup tujuan.",
      "Lengkapi JID di config/whatsapp.json pada target_groups, lalu kirim ulang file jika perlu.",
    ].join("\n"),
  });
}

// mengelompokkan tiket valid berdasarkan JID grup tujuan agar pembuka/reminder dikirim sekali per grup.
async function groupTicketsByTarget(sock, sourceJid, tickets) {
  const groups = new Map();

  for (const ticket of tickets) {
    const targetJid = resolveTargetJid(ticket);
    if (!targetJid) {
      await sendMissingTargetGroupAlert(sock, sourceJid, ticket);
      continue;
    }

    const group = groups.get(targetJid) || [];
    group.push(ticket);
    groups.set(targetJid, group);
  }

  logger.info("Tickets grouped by target JID", {
    targetGroups: groups.size,
    tickets: tickets.length,
  });

  return groups;
}

// mengirim salam, file Excel, dan reminder ke grup tujuan sebelum tiket detail dikirim satu per satu.
async function sendTargetGroupPreamble(sock, targetJid, tickets) {
  logger.info("Sending target group preamble", {
    targetJid,
    tickets: tickets.length,
    assignmentType: tickets[0]?.assignment_type,
  });

  await sock.sendMessage(targetJid, {
    text: formatTargetGroupOpeningMessage(),
  });

  const workbookBuffer = await createFilteredTicketsExcel({
    valid_tickets: tickets,
  });
  await sock.sendMessage(targetJid, {
    document: workbookBuffer,
    mimetype:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: formatUpdateTicketFileName(),
    caption: "File Excel berisi tiket yang dikirim ke grup ini.",
  });

  await sock.sendMessage(targetJid, formatReminderMessagePayload(tickets));
}

// mengirim salam, Excel, dan reminder summary ke MAIN SQA tanpa mengirim detail tiket satu per satu.
async function sendMainSqaSummaryOnly(
  sock,
  sourceJid,
  ticketsByTarget,
  validTickets,
) {
  const sqaTickets = validTickets.filter(
    (ticket) => ticket.assignment_type === "SQA",
  );
  if (sqaTickets.length === 0) {
    logger.info("MAIN SQA summary skipped: no SQA tickets");
    return;
  }

  const mainSqaGroup = getGroupConfig("MAIN SQA");
  if (!mainSqaGroup?.jid) {
    logger.warn("MAIN SQA summary skipped: target group JID is not configured", {
      sqaTickets: sqaTickets.length,
    });
    await sock.sendMessage(sourceJid, {
      text: [
        "Alert konfigurasi MAIN SQA kosong.",
        "",
        `Total tiket SQA: ${sqaTickets.length}`,
        "",
        "Salam, Excel, dan reminder summary MAIN SQA tidak dikirim.",
        "Lengkapi JID di config/whatsapp.json pada target_groups dengan key MAIN SQA.",
      ].join("\n"),
    });
    return;
  }

  if (ticketsByTarget.has(mainSqaGroup.jid)) {
    logger.warn("MAIN SQA summary skipped: JID is already used by detail target group", {
      mainSqaJid: mainSqaGroup.jid,
      sqaTickets: sqaTickets.length,
    });
    return;
  }

  logger.info("Sending MAIN SQA summary-only preamble", {
    targetJid: mainSqaGroup.jid,
    sqaTickets: sqaTickets.length,
  });
  await sendTargetGroupPreamble(sock, mainSqaGroup.jid, sqaTickets);
}

// mengirim summary, report, Excel balasan, preamble grup, dan pesan eskalasi ke grup tujuan.
async function sendImportResult(sock, sourceJid, result, options = {}) {
  const ticketOnlyMode = Boolean(options.ticketOnlyMode);
  logger.info("Sending import summary", {
    sourceJid,
    ok: result.ok,
    total: result.total_rows,
    valid: result.valid_count,
    skipped: result.skipped_count,
    ticketOnlyMode,
  });

  await sock.sendMessage(sourceJid, {
    text: formatImportSummary(result),
  });

  if (!result.ok) {
    logger.warn("Import result is not OK, stopping outbound ticket send", {
      reason: result.reason,
      missingColumns: result.missing_columns,
    });
    return;
  }

  if (ticketOnlyMode) {
    logger.info("Import is running in .update ticket-only mode", {
      sourceJid,
      validTickets: result.valid_tickets.length,
    });
    await sock.sendMessage(sourceJid, {
      text: [
        "Mode .update aktif.",
        "Bot hanya mengirim detail tiket ke grup target.",
        "Salam pembuka, Excel target, dan reminder summary dilewati.",
      ].join("\n"),
    });
  }

  const processingReport = formatProcessingReport(result);
  if (processingReport) {
    logger.info("Sending processing report");
    await sock.sendMessage(sourceJid, {
      text: processingReport,
    });
  }

  if (result.valid_tickets.length > 0) {
    logger.info("Creating and sending filtered Excel reply", {
      validTickets: result.valid_tickets.length,
    });
    const workbookBuffer = await createFilteredTicketsExcel(result);
    await sock.sendMessage(sourceJid, {
      document: workbookBuffer,
      mimetype:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: "filtered_ccm_tickets.xlsx",
      caption: "File Excel hasil filter tiket.",
    });
  }

  const sentTicketPlan = await createSentTicketPlan(result.valid_tickets);
  await sock.sendMessage(sourceJid, {
    text: formatSentTicketPlanReport(sentTicketPlan),
  });

  if (sentTicketPlan.sendable_tickets.length === 0) {
    logger.info("No tickets left to send after deduplication/SLA checks", {
      sourceJid,
      duplicate: sentTicketPlan.duplicate_tickets.length,
      outSla: sentTicketPlan.out_sla_tickets.length,
    });
    return;
  }

  const ticketsByTarget = await groupTicketsByTarget(
    sock,
    sourceJid,
    sentTicketPlan.sendable_tickets,
  );

  if (ticketOnlyMode) {
    logger.info("Skipping MAIN SQA summary in .update ticket-only mode", {
      sourceJid,
    });
  } else {
    await sendMainSqaSummaryOnly(
      sock,
      sourceJid,
      ticketsByTarget,
      sentTicketPlan.sendable_tickets,
    );
  }

  for (const [targetJid, tickets] of ticketsByTarget.entries()) {
    if (ticketOnlyMode) {
      logger.info("Skipping target group preamble in .update ticket-only mode", {
        targetJid,
        tickets: tickets.length,
      });
    } else {
      await sendTargetGroupPreamble(sock, targetJid, tickets);
    }

    for (const ticket of tickets) {
      logger.info("Sending escalation ticket", {
        orderId: ticket.order_id,
        assignmentType: ticket.assignment_type,
        targetJid,
        pic: ticket.pic,
      });
      await enqueueTicketMessage(
        async () => {
          await sock.sendMessage(
            targetJid,
            formatEscalationMessagePayload(ticket),
          );
          await markTicketAsSent(ticket, { sourceJid, targetJid });
        },
        {
          orderId: ticket.order_id,
          assignmentType: ticket.assignment_type,
          targetJid,
          pic: ticket.pic,
        },
      );
    }
  }
}

// handler utama pesan masuk; hanya memproses dokumen Excel dari grup/private yang diizinkan.
async function handleIncomingMessage(sock, messageEvent) {
  const message = messageEvent.messages?.[0];
  if (!message?.message) {
    logger.debug("Ignoring empty message");
    return;
  }

  const sourceJid = message.key.remoteJid;
  if (message.key.fromMe) {
    logger.debug("Ignoring fromMe message");
    return;
  }

  const senderJid = getMessageSenderJid(message);
  upsertPrivate(senderJid, { pushName: message.pushName });
  if (isPrivateJid(sourceJid)) {
    upsertPrivate(sourceJid, { pushName: message.pushName });
  }

  logger.info("Incoming WhatsApp message", {
    sourceJid,
    senderJid,
    text: getMessageText(message.message),
  });

  const text = getMessageText(message.message);
  const documentMessage = getDocumentMessage(message.message);
  if (text.startsWith(".") && !documentMessage) {
    await handleBotCommand(sock, { sourceJid, senderJid, text });
    return;
  }

  if (!documentMessage) {
    logger.debug("Incoming message has no document, ignoring");
    return;
  }

  const importOptions = getDocumentImportOptions(text);
  if (!importOptions.supported) {
    logger.warn("Incoming document rejected: unsupported caption command", {
      sourceJid,
      senderJid,
      command: importOptions.command,
      fileName: documentMessage.fileName,
    });
    await sock.sendMessage(sourceJid, {
      text: [
        `Command caption tidak dikenal: ${importOptions.command}`,
        "",
        "Untuk kirim normal, kosongkan caption file Excel.",
        "Untuk mode update tiket saja, gunakan caption .update.",
      ].join("\n"),
    });
    return;
  }

  if (!isAllowedBotAccess({ sourceJid, senderJid })) {
    logger.warn("Incoming Excel rejected: source/sender is not allowed", {
      sourceJid,
      senderJid,
      fileName: documentMessage.fileName,
    });
    await sock.sendMessage(sourceJid, {
      text: UNAUTHORIZED_TEXT,
    });
    return;
  }

  if (!isSupportedExcelFile(documentMessage)) {
    logger.warn("Unsupported document format", {
      sourceJid,
      fileName: documentMessage.fileName,
      mimetype: documentMessage.mimetype,
    });
    await sock.sendMessage(sourceJid, {
      text: "File diterima, tetapi format belum didukung. Kirim file Excel .xlsx.",
    });
    return;
  }

  await sock.sendMessage(sourceJid, {
    text: importOptions.ticketOnlyMode
      ? "File Excel diterima dengan mode .update. Sedang memproses tiket..."
      : "File Excel diterima. Sedang memproses tiket...",
  });

  try {
    const buffer = await downloadDocumentBuffer(documentMessage);
    logger.info("Starting ticket Excel process", {
      ticketOnlyMode: importOptions.ticketOnlyMode,
    });
    const result = await processTicketExcel(buffer);
    logger.info("Ticket Excel process completed", {
      total: result.total_rows,
      valid: result.valid_count || 0,
      skipped: result.skipped_count || 0,
      ticketOnlyMode: importOptions.ticketOnlyMode,
    });
    await sendImportResult(sock, sourceJid, result, importOptions);
  } catch (error) {
    logger.error("Failed to process incoming Excel", error);
    await sock.sendMessage(sourceJid, {
      text: `Gagal memproses file Excel: ${error.message}`,
    });
  }
}

// membuat koneksi Baileys, menangani QR login, reconnect, dan event pesan masuk.
export async function startBot() {
  logger.info("Starting WhatsApp bot auth state", { authDir: AUTH_DIR });
  releaseSessionLock = acquireProcessLock(AUTH_DIR, "whatsapp-bot");
  bindSessionLockCleanup();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const envVersion = parseWaWebVersion(process.env.WA_WEB_VERSION);
  const { version: latestVersion } = envVersion
    ? { version: envVersion }
    : await fetchLatestBaileysVersion();
  const version = envVersion || latestVersion;

  logger.info("Starting WhatsApp socket", {
    waWebVersion: version.join("."),
    versionSource: envVersion ? "env" : "latest",
  });

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    version,
    logger: pino({ level: BAILEYS_LOG_LEVEL }),
  });

  sock.ev.on("creds.update", saveCreds);
  bindCommandIndexEvents(sock);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info(
        "QR login received. Scan from WhatsApp > Linked devices > Link a device",
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      logger.info("WhatsApp bot connected");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason =
        lastDisconnect?.error?.output?.payload?.message ||
        lastDisconnect?.error?.message;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        logger.warn("WhatsApp connection closed, reconnecting in 5 seconds", {
          statusCode: statusCode || "unknown",
          reason: reason || "no reason",
        });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startBot().catch((error) => {
            logger.error("Failed to reconnect WhatsApp bot", error);
          });
        }, 5000);
      } else {
        logger.warn(
          "WhatsApp logged out. Delete auth dir and start again to scan a new QR",
          {
            authDir: AUTH_DIR,
          },
        );
      }
    }
  });

  sock.ev.on("messages.upsert", (messageEvent) => {
    handleIncomingMessage(sock, messageEvent).catch((error) => {
      logger.error("Failed to handle incoming message", error);
    });
  });
}
