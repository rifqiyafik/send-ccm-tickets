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
import { getGroupConfig, getMentionContact } from "../config/appConfig.js";
import { createLogger } from "../utils/logger.js";
import {
  getMessageSenderJid,
  isGroupJid,
  isPrivateJid,
  normalizeJid,
} from "../utils/jid.js";
import { cleanInlineText } from "../utils/text.js";
import { acquireProcessLock } from "../utils/processLock.js";
import {
  cancelQueue,
  enqueueTicketMessage,
  isQueueCancelled,
} from "../services/messageQueueService.js";
import { getWhatsAppAccessDecision } from "../services/accessControlService.js";
import {
  createSentTicketPlan,
  formatSentTicketPlanReport,
  formatSqaAreaFollowUpMessage,
  markTicketAsSent,
} from "../services/sentTicketService.js";
import {
  createFilteredTicketsExcel,
  formatEscalationMessagePayload,
  formatInProgressReminderMessagePayload,
  formatImportSummary,
  formatProcessingReport,
  formatReminderMessagePayload,
  formatTargetGroupOpeningMessage,
  formatUpdateTicketFileName,
  processTicketExcel,
} from "../services/ticketImportService.js";

const AUTH_DIR = process.env.WA_AUTH_DIR || "sessions/baileys";
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || "silent";
const UNAUTHORIZED_TEXT = "sorry, you are not in our system\nbye bye 👋";
const MAX_COMMAND_RESULT = Number(process.env.BOT_COMMAND_RESULT_LIMIT || 10);
const MAX_MESSAGE_LENGTH = 3500;
const TICKET_PROGRESS_INTERVAL = Number(
  process.env.TICKET_PROGRESS_INTERVAL || 10,
);
const TARGET_GROUP_COMPLETION_DELAY_MS = Number(
  process.env.TARGET_GROUP_COMPLETION_DELAY_MS || 10000,
);
const logger = createLogger("whatsappMessageHandler");
const groupIndex = new Map();
const privateIndex = new Map();
let reconnectTimer = null;
let releaseSessionLock = null;
let activeSock = null;
let activeController = null;
let activeConnectionGeneration = 0;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

// membaca caption command pada dokumen Excel agar file tanpa command tidak dieksekusi otomatis.
function getDocumentImportOptions(text) {
  const trimmedText = String(text || "").trim();

  if (!trimmedText) {
    return {
      command: "",
      supported: false,
      missingCommand: true,
      ticketOnlyMode: false,
      summaryOnlyMode: false,
      reminderMode: false,
    };
  }

  if (!trimmedText.startsWith(".") && !trimmedText.startsWith("/")) {
    return {
      command: trimmedText,
      supported: false,
      missingCommand: false,
      ticketOnlyMode: false,
      summaryOnlyMode: false,
      reminderMode: false,
    };
  }

  const { command, argument } = parseBotCommand(trimmedText);
  const words = trimmedText.toLowerCase().split(/\s+/);
  const manualMode = words.includes("manual");

  const normalMode = [".import", ".send", "/import", "/send", ".manual", "/manual"].includes(command);
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
    manualMode: manualMode || command === ".manual" || command === "/manual",
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
function formatWhatsAppGroupHelp({ sourceJid, senderJid, allowed }) {
  return [
    "🤖 *CCM Ticket Bot (Group Guide)*",
    "",
    `Access: ${allowed ? "ALLOWED" : "DENIED"}`,
    `Source JID: ${sourceJid || "-"}`,
    `Sender JID: ${senderJid || "-"}`,
    "",
    "⚠️ *Langkah Wajib Sebelum Mengirim File Tiket:*",
    "1. *Cek Koneksi WhatsApp Bot*: Ketik `.status` terlebih dahulu.",
    "2. *Pastikan Session WhatsApp Aktif*: Jika status terputus/stopped, hubungi Admin untuk melakukan `/login` di Telegram / Chat Personal Bot terlebih dahulu sebelum mengirimkan file Excel!",
    "",
    "--------------------------------------------------",
    "",
    "📤 *Cara Mengirim File Tiket Excel:*",
    "- Kirim file Excel (`.xlsx` / `.xls`) dengan **Caption Command**:",
    "",
    "🔹 *Mode Pengiriman File:*",
    "• *Tanpa Caption / `.import` / `.send`*: Kirim tiket normal ke grup target SQA & NOP + Excel balasan.",
    "• `.update`: Kirim detail tiket eskalasi saja ke grup target (tanpa salam & summary).",
    "• `.summary`: Kirim report/summary & Excel balasan saja ke chat ini.",
    "• `.reminder`: Kirim reminder semua tiket yang belum resolve di file Excel.",
    "",
    "--------------------------------------------------",
    "",
    "📊 *Fitur Utama:*",
    "✅ Routing otomatis ke grup SQA & NOP.",
    "✅ Auto mention ke PIC CCM & PIC SQA/NOP.",
    "✅ Deteksi ReOpen & kalkulasi waktu Out SLA.",
  ].join("\n");
}

function formatWhatsAppPersonalHelp({ sourceJid, senderJid, allowed }) {
  return [
    "🤖 *CCM Ticket Bot (Personal Guide)*",
    "",
    `Access: ${allowed ? "ALLOWED" : "DENIED"}`,
    `Source JID: ${sourceJid || "-"}`,
    `Sender JID: ${senderJid || "-"}`,
    "",
    "📌 *Daftar Command & Fitur:*",
    "",
    "🔹 *Pengecekan & Monitoring:*",
    "• `.status` : Cek status koneksi, user aktif, & index",
    "• `.groups` : Lihat semua daftar grup WhatsApp dari session aktif",
    "• `.groups <keyword>` : Cari grup WhatsApp spesifik (contoh: `.groups nop`)",
    "• `.private` : Lihat daftar kontak private chat WhatsApp",
    "• `.private <keyword>` : Cari kontak private chat spesifik",
    "• `.help` / `.` : Tampilkan panduan ini",
    "",
    "📤 *Mode Pengiriman Excel:*",
    "• `.import` / `.send` + File Excel : Kirim tiket normal ke grup target",
    "• `.update` + File Excel : Kirim detail tiket eskalasi saja ke grup target",
    "• `.summary` + File Excel : Kirim report & Excel balasan saja",
    "• `.reminder` + File Excel : Kirim reminder tiket belum resolve",
    "",
    "🔐 *Manajemen Session & Bot (via Telegram Command Center):*",
    "- Gunakan Bot Telegram untuk `/sessions`, `/login`, `/stop`, `/logout`, `/delete_session`, `/change_env`.",
    "",
    "---",
    "📝 *Catatan Akses:*",
    "- Grup sumber harus terdaftar di `authorized_groups`.",
    "- Private chat harus terdaftar di `authorized_users` atau `OWNER_JIDS`.",
  ].join("\n");
}

function formatCommandHelp({ sourceJid, senderJid, allowed }) {
  const isGroup = String(sourceJid || "").endsWith("@g.us");
  return isGroup
    ? formatWhatsAppGroupHelp({ sourceJid, senderJid, allowed })
    : formatWhatsAppPersonalHelp({ sourceJid, senderJid, allowed });
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

// #penjelasan: dipakai Telegram command center untuk menampilkan daftar grup dari session WhatsApp aktif.
export async function formatWhatsAppGroupsCommand(keyword = "") {
  if (activeSock) {
    await refreshGroups(activeSock);
  }

  return formatJidList({
    label: "WhatsApp groups",
    items: [...groupIndex.values()],
    keyword,
  });
}

// #penjelasan: dipakai Telegram command center untuk menampilkan private chat/kontak yang sudah ter-index.
export function formatWhatsAppPrivateCommand(keyword = "") {
  return formatJidList({
    label: "WhatsApp private chats",
    items: [...privateIndex.values()],
    keyword,
  });
}

// membuat output status singkat untuk memastikan bot hidup dan membaca index lokal.
function formatBotStatus({ sourceJid, senderJid, allowed }) {
  return [
    "📊 **CCM Ticket Bot Status**",
    "",
    `🔐 Access: ${allowed ? "✅ ALLOWED" : "❌ DENIED"}`,
    `📡 Source JID: ${sourceJid || "-"}`,
    `👤 Sender JID: ${senderJid || "-"}`,
    `👥 Indexed Groups: ${groupIndex.size}`,
    `💬 Indexed Private Chats: ${privateIndex.size}`,
    `📏 Result Limit: ${MAX_COMMAND_RESULT}`,
    "",
    "---",
    "ℹ️ Gunakan command sesuai izin akses yang berlaku.",
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
    ![
      ".",
      ".help",
      ".status",
      ".groups",
      ".private",
      ".import",
      ".send",
      ".update",
      ".summary",
      ".cancel",
      "/cancel",
    ].includes(command)
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

  const accessDecision = getWhatsAppAccessDecision({ sourceJid, senderJid });
  const allowed = accessDecision.allowed;
  logger.info("Bot command access checked", {
    sourceJid,
    senderJid,
    command,
    allowed,
    reason: accessDecision.reason,
    sourceType: accessDecision.source_type,
  });

  if (command === ".cancel" || command === "/cancel") {
    cancelActiveDelivery("WhatsApp .cancel command");
    await sock.sendMessage(sourceJid, {
      text: [
        "🛑 **Pembatalan Proses Selesai**",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "✅ Seluruh antrian dan pengiriman tiket WhatsApp yang sedang berjalan berhasil dihentikan.",
      ].join("\n"),
    });
    return;
  }

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
        "⚙️ **Mode .update**",
        "",
        "📌 Digunakan sebagai *caption* file Excel.",
        "",
        "➡️ Kirim file Excel dengan caption `.update` untuk hanya mengirim **detail tiket** ke grup target.",
        "🚫 Salam pembuka, Excel target, dan reminder summary **tidak dikirim** pada mode ini.",
        "",
        "---",
        "ℹ️ Mode ini cocok untuk update cepat tanpa format tambahan.",
      ].join("\n"),
    });
  }

  if ([".import", ".send"].includes(command)) {
    await sock.sendMessage(sourceJid, {
      text: [
        "📥 **Mode Import Normal**",
        "",
        "📌 Digunakan sebagai *caption* file Excel.",
        "",
        "➡️ Kirim file Excel dengan caption `.import` atau `.send` untuk menjalankan flow lengkap.",
        "✅ Bot akan mengirim salam pembuka, Excel hasil filter, reminder summary, dan detail tiket ke grup target.",
      ].join("\n"),
    });
  }

  if (command === ".summary") {
    await sock.sendMessage(sourceJid, {
      text: [
        "📊 **Mode .summary**",
        "",
        "📌 Digunakan sebagai *caption* file Excel.",
        "",
        "➡️ Kirim file Excel dengan caption `.summary` untuk membuat report/summary saja.",
        "🚫 Detail tiket tidak dikirim ke grup target pada mode ini.",
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
      "⚠️ **Alert: Target Group Kosong**",
      "",
      `🆔 Order ID: ${ticket.order_id || "-"}`,
      `📌 Assignment: ${ticket.assignment_type || "-"}`,
      `🔑 Target Group Key: ${targetGroupKey || "-"}`,
      `👤 PIC: ${ticket.pic || "-"}`,
      "",
      "🚫 Tiket ini **tidak dikirim** ke grup tujuan.",
      "👉 Lengkapi JID di `config/whatsapp.json` pada `target_groups`, lalu kirim ulang file jika perlu.",
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

// mengirim salam dan file Excel ke grup tujuan sebelum tiket detail dikirim satu per satu.
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
    // caption: "File Excel berisi tiket yang dikirim ke grup ini.",
  });
}

async function sendTargetGroupReminder(sock, targetJid, tickets, options = {}) {
  logger.info("Sending target group reminder", {
    targetJid,
    tickets: tickets.length,
    assignmentType: tickets[0]?.assignment_type,
    options,
  });
  await sock.sendMessage(
    targetJid,
    formatReminderMessagePayload(tickets, options),
  );
}

function getSummaryReminderGroupKey(ticket) {
  const assignmentType = String(ticket.assignment_type || "")
    .trim()
    .toUpperCase();
  if (assignmentType === "SQA") {
    return "SQA";
  }

  return formatTargetProgressLabel([ticket]);
}

function groupTicketsForSummaryReminder(tickets) {
  const groups = new Map();
  for (const ticket of tickets) {
    const key = getSummaryReminderGroupKey(ticket);
    const group = groups.get(key) || [];
    group.push(ticket);
    groups.set(key, group);
  }
  return groups;
}

async function sendSummaryOnlyReminderMessages(sock, sourceJid, tickets) {
  const groupsByTarget = await groupTicketsByTarget(sock, sourceJid, tickets);
  const mainSqaGroup = getGroupConfig("MAIN SQA");
  logger.info("Sending .summary reminder messages to WhatsApp target groups", {
    sourceJid,
    targetGroups: groupsByTarget.size,
    tickets: tickets.length,
  });

  for (const [targetJid, targetTickets] of groupsByTarget.entries()) {
    const reminderGroups = groupTicketsForSummaryReminder(targetTickets);

    for (const [groupKey, groupTickets] of reminderGroups.entries()) {
      const isSqaSummary = groupKey === "SQA";
      const reminderTargetJid = isSqaSummary ? mainSqaGroup?.jid : targetJid;

      if (!reminderTargetJid) {
        logger.warn(".summary reminder skipped: target JID is not configured", {
          sourceJid,
          groupKey,
          tickets: groupTickets.length,
          assignmentType: groupTickets[0]?.assignment_type,
        });
        await sendTargetDeliveryFailedAlert(sock, sourceJid, {
          targetJid: isSqaSummary ? "MAIN SQA" : targetJid,
          stage: ".summary reminder target missing",
          tickets: groupTickets,
          error: new Error(
            isSqaSummary
              ? "MAIN SQA target group belum dikonfigurasi."
              : "Target group belum dikonfigurasi.",
          ),
        });
        continue;
      }

      const payload = formatReminderMessagePayload(groupTickets, {
        targetGroupKey: isSqaSummary
          ? "MAIN SQA"
          : getTargetGroupKey(reminderTargetJid),
        usePicSqa: isSqaSummary,
      });
      logger.info("Sending .summary reminder message to target group", {
        sourceJid,
        targetJid: reminderTargetJid,
        originalTargetJid: targetJid,
        groupKey,
        tickets: groupTickets.length,
        assignmentType: groupTickets[0]?.assignment_type,
      });
      await sock.sendMessage(reminderTargetJid, payload);
    }
  }
}

function getErrorMessage(error) {
  return error?.message || String(error || "Unknown error");
}

function formatTargetProgressLabel(tickets) {
  const firstTicket = tickets[0] || {};
  const assignmentType = String(firstTicket.assignment_type || "")
    .trim()
    .toUpperCase();

  if (assignmentType === "NOP") {
    const source = cleanInlineText(
      firstTicket.cluster_area || firstTicket.nsa || firstTicket.assignment_group,
    )
      .replace(/^NOP\s+/i, "")
      .trim();

    return source ? `NOP ${source}` : "NOP";
  }

  return assignmentType || cleanInlineText(firstTicket.assignment_group) || "Target";
}

function formatProgressBar(current, total, length = 10) {
  if (!total || total <= 0) return "[░░░░░░░░░░] 0%";
  const ratio = Math.min(Math.max(current / total, 0), 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  const percent = Math.round(ratio * 100);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${current}/${total} Tiket (${percent}%)`;
}

const activeProgressTracker = new Map();
let activeDeliveryCancelled = false;
let activeDeliverySleepTimer = null;
let activeDeliverySleepResolve = null;

// membatalkan seluruh proses pengiriman tiket yang sedang berjalan dan mereset kartu progress.
export function cancelActiveDelivery(reason = "Cancelled by user") {
  logger.warn("Active ticket delivery cancelled", { reason });
  activeDeliveryCancelled = true;
  cancelQueue(reason);

  if (activeDeliverySleepTimer) {
    clearTimeout(activeDeliverySleepTimer);
    activeDeliverySleepTimer = null;
  }
  if (activeDeliverySleepResolve) {
    activeDeliverySleepResolve();
    activeDeliverySleepResolve = null;
  }

  for (const [sourceJid, existingKey] of activeProgressTracker.entries()) {
    if (activeSock?.sendMessage) {
      activeSock
        .sendMessage(sourceJid, {
          text: [
            "🛑 **PENGIRIMAN TIKET DIBATALKAN**",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "⚠️ Proses pengiriman tiket berhasil dihentikan oleh pengguna (`/cancel`).",
          ].join("\n"),
          edit: existingKey,
          isProgress: true,
          isFinal: true,
        })
        .catch(() => {});
    }
  }
  activeProgressTracker.clear();

  return true;
}

export function isDeliveryCancelled() {
  return activeDeliveryCancelled || isQueueCancelled();
}

async function sendTicketProgressMessage(sock, sourceJid, text, meta = {}) {
  try {
    logger.info("Sending ticket progress message", {
      sourceJid,
      ...meta,
    });

    const isFinal = Boolean(meta.isFinal);
    const existingKey = activeProgressTracker.get(sourceJid);

    if (existingKey && sock?.sendMessage) {
      try {
        const payload = {
          text,
          edit: existingKey,
          isProgress: true,
          ...meta,
        };
        const editResult = await sock.sendMessage(sourceJid, payload);
        if (isFinal) {
          activeProgressTracker.delete(sourceJid);
        } else if (editResult?.key) {
          activeProgressTracker.set(sourceJid, editResult.key);
        }
        return editResult;
      } catch (editError) {
        logger.warn(
          "Failed to edit existing progress message, fallback to sending new message",
          {
            sourceJid,
            error: editError.message,
          },
        );
      }
    }

    const payload = {
      text,
      isProgress: true,
      ...meta,
    };
    const sent = await sock.sendMessage(sourceJid, payload);
    if (isFinal) {
      activeProgressTracker.delete(sourceJid);
    } else if (sent?.key) {
      activeProgressTracker.set(sourceJid, sent.key);
    }
    return sent;
  } catch (error) {
    logger.error("Failed to send ticket progress message", {
      sourceJid,
      ...meta,
      message: getErrorMessage(error),
      stack: error?.stack,
    });
  }
}

// mengirim alert ke pengirim file ketika pengiriman ke grup target gagal.
async function sendTargetDeliveryFailedAlert(
  sock,
  sourceJid,
  { targetJid, stage, tickets = [], error },
) {
  const sampleOrders = tickets
    .slice(0, 5)
    .map((ticket) => ticket.order_id)
    .filter(Boolean);

  logger.error("Target delivery failed", {
    stage,
    targetJid,
    tickets: tickets.length,
    sampleOrders,
    message: getErrorMessage(error),
    stack: error?.stack,
  });

  try {
    await sock.sendMessage(sourceJid, {
      text: [
        "⚠️ **Pengiriman ke Target Gagal**",
        "",
        `Stage: **${stage}**`,
        `Target JID: \`${targetJid || "-"}\``,
        `Total tiket terdampak: ${tickets.length}`,
        sampleOrders.length > 0
          ? `Sample Order ID: \`${sampleOrders.join(", ")}\``
          : "",
        "",
        `Error: \`${getErrorMessage(error)}\``,
        "",
        "Cek apakah JID target group benar, bot masih tergabung di grup, dan session WhatsApp aktif.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (alertError) {
    logger.error("Failed to send target delivery alert to source", alertError);
  }
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
    logger.warn(
      "MAIN SQA summary skipped: target group JID is not configured",
      {
        sqaTickets: sqaTickets.length,
      },
    );
    await sock.sendMessage(sourceJid, {
      text: [
        "⚠️ **Alert: MAIN SQA Kosong**",
        "",
        `📊 Total Tiket SQA: ${sqaTickets.length}`,
        "",
        "🚫 Salam, Excel, dan reminder summary **MAIN SQA tidak dikirim**.",
        "👉 Lengkapi JID di `config/whatsapp.json` pada `target_groups` dengan key **MAIN SQA**.",
      ].join("\n"),
    });
    return;
  }

  if (ticketsByTarget.has(mainSqaGroup.jid)) {
    logger.warn(
      "MAIN SQA summary skipped: JID is already used by detail target group",
      {
        mainSqaJid: mainSqaGroup.jid,
        sqaTickets: sqaTickets.length,
      },
    );
    return;
  }

  logger.info("Sending MAIN SQA summary-only preamble", {
    targetJid: mainSqaGroup.jid,
    sqaTickets: sqaTickets.length,
  });
  try {
    await sendTargetGroupPreamble(sock, mainSqaGroup.jid, sqaTickets);
    await sendTargetGroupReminder(sock, mainSqaGroup.jid, sqaTickets, {
      targetGroupKey: "MAIN SQA",
      usePicSqa: true,
    });
  } catch (error) {
    await sendTargetDeliveryFailedAlert(sock, sourceJid, {
      targetJid: mainSqaGroup.jid,
      stage: "MAIN SQA preamble",
      tickets: sqaTickets,
      error,
    });
  }
}

async function sendDailyInProgressReminders(sock, sourceJid, reminderTickets) {
  if (!reminderTickets || reminderTickets.length === 0) {
    logger.info("Daily In Progress reminder skipped: no reminder tickets");
    return;
  }

  const remindersByTarget = await groupTicketsByTarget(
    sock,
    sourceJid,
    reminderTickets,
  );

  logger.info("Sending daily In Progress reminders to detail target groups", {
    sourceJid,
    targetGroups: remindersByTarget.size,
    tickets: reminderTickets.length,
  });

  for (const [targetJid, tickets] of remindersByTarget.entries()) {
    try {
      await sock.sendMessage(
        targetJid,
        formatInProgressReminderMessagePayload(tickets),
      );

      for (const ticket of tickets) {
        await markTicketAsSent(ticket, { sourceJid, targetJid });
      }
    } catch (error) {
      await sendTargetDeliveryFailedAlert(sock, sourceJid, {
        targetJid,
        stage: "daily in progress reminder",
        tickets,
        error,
      });
    }
  }
}

export async function sendReminderCommandResult(
  sock,
  sourceJid,
  validTickets,
  options = {},
) {
  if (!validTickets || validTickets.length === 0) {
    logger.info("Reminder command skipped: no valid tickets");
    await sock.sendMessage(sourceJid, {
      text: "⚠️ Tidak ada tiket valid yang dapat di-remind dari file Excel ini.",
    });
    return;
  }

  const sqaTickets = validTickets.filter(
    (ticket) => ticket.assignment_type === "SQA",
  );
  const nopTickets = validTickets.filter(
    (ticket) => ticket.assignment_type === "NOP",
  );

  logger.info("Processing .reminder command result", {
    sourceJid,
    totalValid: validTickets.length,
    sqaCount: sqaTickets.length,
    nopCount: nopTickets.length,
  });

  // 1. Process NOP tickets: send reminder to NOP target groups
  if (nopTickets.length > 0) {
    const nopRemindersByTarget = await groupTicketsByTarget(
      sock,
      sourceJid,
      nopTickets,
    );

    for (const [targetJid, tickets] of nopRemindersByTarget.entries()) {
      try {
        const payload = formatInProgressReminderMessagePayload(tickets, {
          isReminderCmd: true,
          includeSummary: true,
        });

        if (payload.text) {
          await sock.sendMessage(targetJid, payload);
          logger.info("Sent NOP .reminder payload to target group", {
            targetJid,
            tickets: tickets.length,
          });
        }
      } catch (error) {
        await sendTargetDeliveryFailedAlert(sock, sourceJid, {
          targetJid,
          stage: "reminder command NOP",
          tickets,
          error,
        });
      }
    }
  }

  // 2. Process SQA tickets: group by ccm_handling, send JAPRI (Direct Message)
  if (sqaTickets.length > 0) {
    const sqaGroupedByCcm = new Map();
    for (const ticket of sqaTickets) {
      const ccmName = ticket.ccm_handling || ticket.pic_sqa || "UNKNOWN";
      const key = cleanInlineText(ccmName).toUpperCase();
      const group = sqaGroupedByCcm.get(key) || { name: ccmName, tickets: [] };
      group.tickets.push(ticket);
      sqaGroupedByCcm.set(key, group);
    }

    for (const { name, tickets } of sqaGroupedByCcm.values()) {
      const contact = getMentionContact(name);
      const payload = formatInProgressReminderMessagePayload(tickets, {
        isReminderCmd: true,
        includeSummary: true,
      });

      if (!payload.text) continue;

      if (contact && contact.jid) {
        try {
          await sock.sendMessage(contact.jid, payload);
          logger.info("Sent SQA .reminder JAPRI to PIC CCM", {
            ccmName: name,
            contactJid: contact.jid,
            tickets: tickets.length,
          });
        } catch (error) {
          logger.error(
            "Failed to send SQA reminder JAPRI, falling back to Telegram source chat",
            {
              ccmName: name,
              contactJid: contact.jid,
              error,
            },
          );
          await sock.sendMessage(sourceJid, {
            text: `⚠️ **Gagal JAPRI WA ke ${name} (${contact.jid})**\n\n${payload.text}`,
          });
        }
      } else {
        logger.warn(
          "PIC CCM WhatsApp contact not found, falling back to Telegram source chat",
          {
            ccmName: name,
            sourceJid,
          },
        );
        await sock.sendMessage(sourceJid, {
          text: `⚠️ **[FALLBACK SQA REMINDER]**\nNomor WA untuk PIC CCM **${name}** belum terdaftar di config mentions.\nBerikut reminder tiketnya:\n\n${payload.text}`,
        });
      }
    }

    // Send SQA reminder summary to MAIN SQA group with pic_sqa tags
    const mainSqaJid = resolveTargetJid({
      assignment_type: "SQA",
      cluster_area: "MAIN SQA",
    });

    if (mainSqaJid) {
      try {
        const mainSqaPayload = formatInProgressReminderMessagePayload(
          sqaTickets,
          {
            isReminderCmd: true,
            includeSummary: true,
            usePicSqa: true,
            targetGroupKey: "MAIN SQA",
          },
        );

        if (mainSqaPayload.text) {
          await sock.sendMessage(mainSqaJid, mainSqaPayload);
          logger.info("Sent SQA /reminder payload to MAIN SQA group", {
            mainSqaJid,
            tickets: sqaTickets.length,
          });
        }
      } catch (error) {
        logger.error(
          "Failed to send SQA /reminder payload to MAIN SQA group",
          {
            mainSqaJid,
            error,
          },
        );
      }
    }
  }
}

// mengirim summary, report, Excel balasan, preamble grup, dan pesan eskalasi ke grup tujuan.
export async function sendImportResult(sock, sourceJid, result, options = {}) {
  activeDeliveryCancelled = false;
  const manualMode = Boolean(options.manualMode);
  const specialMode = Boolean(options.specialMode);
  const ticketOnlyMode = Boolean(options.ticketOnlyMode);
  const summaryOnlyMode = Boolean(options.summaryOnlyMode);
  const reminderMode = Boolean(options.reminderMode);
  logger.info("Sending import summary", {
    sourceJid,
    ok: result.ok,
    total: result.total_rows,
    valid: result.valid_count,
    skipped: result.skipped_count,
    manualMode,
    specialMode,
    ticketOnlyMode,
    summaryOnlyMode,
    reminderMode,
  });

  const baseMode = specialMode
    ? ".special"
    : ticketOnlyMode
    ? ".update"
    : summaryOnlyMode
    ? ".summary"
    : reminderMode
    ? ".reminder"
    : ".import";
  const modeName = manualMode ? `${baseMode} manual` : (baseMode === ".import" ? null : baseMode);
  const modeNote = manualMode
    ? "Mode `manual` aktif: Seluruh tiket, file Excel, dan reminder dikirimkan ke Telegram untuk diteruskan secara manual ke WhatsApp."
    : specialMode
    ? "Mode `.special` aktif: Seluruh tiket valid dikirim ulang ke grup target dan sent_tickets.json diperbarui (bypass cek duplikat)."
    : ticketOnlyMode
    ? "Mode `.update` aktif: Detail tiket dikirim langsung ke grup target tanpa salam pembuka & reminder summary."
    : summaryOnlyMode
    ? "Mode `.summary` aktif: Bot hanya membuat report dan summary tanpa mengirim detail tiket ke grup target."
    : reminderMode
    ? "Mode `.reminder` aktif: Tiket baru dikirim lebih dulu jika ada, diikuti pengiriman reminder."
    : null;

  await sock.sendMessage(sourceJid, {
    text: formatImportSummary(result, { mode: modeName, modeNote }),
  });

  if (!result.ok || isDeliveryCancelled()) {
    logger.warn("Import result is not OK or cancelled, stopping outbound ticket send", {
      reason: result.reason,
      missingColumns: result.missing_columns,
      cancelled: isDeliveryCancelled(),
    });
    return;
  }

  const processingReport = formatProcessingReport(result);
  if (processingReport) {
    logger.info("Sending processing report");
    await sock.sendMessage(sourceJid, {
      text: processingReport,
    });
  }

  if (isDeliveryCancelled()) {
    return;
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
      fileName: formatUpdateTicketFileName(),
      caption: "File Excel hasil filter tiket.",
    });
  }

  if (isDeliveryCancelled()) {
    return;
  }

  const sentTicketPlan = await createSentTicketPlan(
    result.valid_tickets,
    new Date(),
    options,
  );
  await sock.sendMessage(sourceJid, {
    text: formatSentTicketPlanReport(sentTicketPlan),
  });

  if (isDeliveryCancelled()) {
    return;
  }

  const sqaAreaFollowUpMessage = formatSqaAreaFollowUpMessage(
    result.valid_tickets,
  );
  if (sqaAreaFollowUpMessage) {
    logger.info("Sending SQA area follow-up message", {
      sourceJid,
      sqaTickets: result.valid_tickets.filter(
        (ticket) => ticket.assignment_type === "SQA",
      ).length,
      source: "valid_tickets",
    });
    await sock.sendMessage(sourceJid, {
      text: sqaAreaFollowUpMessage,
    });
  }

  if (summaryOnlyMode) {
    await sendSummaryOnlyReminderMessages(
      sock,
      sourceJid,
      result.valid_tickets,
    );
    logger.info("Stopping import flow after summary-only report", {
      sourceJid,
      validTickets: result.valid_tickets.length,
    });
    return;
  }

  if (reminderMode) {
    const sendableCount = sentTicketPlan.sendable_tickets.length;
    if (sendableCount > 0) {
      logger.info(
        "Sending unsent ticket details first before reminder delivery in .reminder mode",
        {
          sourceJid,
          sendableCount,
        },
      );
      await sendTicketDetailsToTargetGroups(
        sock,
        sourceJid,
        sentTicketPlan.sendable_tickets,
        { skipPreamble: true },
      );
    }

    if (isDeliveryCancelled()) {
      logger.info("Stopping reminder flow because delivery was cancelled", {
        sourceJid,
      });
      return;
    }

    await sendReminderCommandResult(
      sock,
      sourceJid,
      result.valid_tickets,
      options,
    );

    if (isDeliveryCancelled()) {
      logger.info("Skipping reminder success message because delivery was cancelled", {
        sourceJid,
      });
      return;
    }

    const reminderOutputLines = [
      "✅ **Reminder Berhasil Dikirim**",
      "",
      sendableCount > 0
        ? `📤 **${sendableCount} tiket baru** telah dikirimkan terlebih dahulu ke grup target.`
        : "ℹ️ Tidak ada tiket baru yang belum terkirim pada file Excel.",
      "",
      "📋 **Status Pengiriman Reminder**:",
      "• SQA: Reminder JAPRI terkirim ke PIC CCM & ringkasan terkirim ke MAIN SQA.",
      "• NOP: Reminder terkirim ke grup NOP target.",
    ];

    await sock.sendMessage(sourceJid, {
      text: reminderOutputLines.join("\n"),
    });

    logger.info("Stopping import flow after reminder command mode", {
      sourceJid,
      validTickets: result.valid_tickets.length,
      sendableCount,
    });
    return;
  }

  if (isDeliveryCancelled()) {
    return;
  }

  await sendDailyInProgressReminders(
    sock,
    sourceJid,
    sentTicketPlan.in_progress_reminder_tickets || [],
  );

  if (isDeliveryCancelled()) {
    return;
  }

  if (ticketOnlyMode) {
    logger.info("Skipping MAIN SQA summary in .update ticket-only mode", {
      sourceJid,
    });
  } else {
    await sendMainSqaSummaryOnly(
      sock,
      sourceJid,
      new Map(),
      result.valid_tickets,
    );
  }

  if (isDeliveryCancelled() || sentTicketPlan.sendable_tickets.length === 0) {
    logger.info("No tickets left to send or delivery cancelled after deduplication/SLA checks", {
      sourceJid,
      duplicate: sentTicketPlan.duplicate_tickets.length,
      outSla: sentTicketPlan.out_sla_tickets.length,
      cancelled: isDeliveryCancelled(),
      inProgressReminder:
        sentTicketPlan.in_progress_reminder_tickets?.length || 0,
    });
    return;
  }

  await sendTicketDetailsToTargetGroups(
    sock,
    sourceJid,
    sentTicketPlan.sendable_tickets,
    { skipPreamble: ticketOnlyMode, manualMode },
  );
}

async function sendTicketDetailsToTargetGroups(
  sock,
  sourceJid,
  sendableTickets,
  options = {},
) {
  const skipPreamble = Boolean(options.skipPreamble);
  const ticketsByTarget = await groupTicketsByTarget(
    sock,
    sourceJid,
    sendableTickets,
  );

  const targetEntries = [...ticketsByTarget.entries()];
  const totalTicketsCount = sendableTickets.length;
  let overallSentCount = 0;

  for (const [targetIndex, [targetJid, tickets]] of targetEntries.entries()) {
    if (isDeliveryCancelled()) {
      logger.warn("Stopping sendTicketDetailsToTargetGroups: delivery cancelled");
      break;
    }

    const targetLabel = formatTargetProgressLabel(tickets);
    let sentCount = 0;
    const nextEntry = targetEntries[targetIndex + 1];

    if (skipPreamble) {
      logger.info(
        "Skipping target group preamble for ticket detail delivery",
        {
          targetJid,
          tickets: tickets.length,
        },
      );
    } else {
      try {
        await sendTargetGroupPreamble(sock, targetJid, tickets);
        if (tickets[0]?.assignment_type !== "SQA") {
          await sendTargetGroupReminder(sock, targetJid, tickets, {
            targetGroupKey: getTargetGroupKey(targetJid),
          });
        }
      } catch (error) {
        await sendTargetDeliveryFailedAlert(sock, sourceJid, {
          targetJid,
          stage: "target group preamble",
          tickets,
          error,
        });
        continue;
      }
    }

    for (const ticket of tickets) {
      if (isDeliveryCancelled()) {
        logger.warn("Stopping ticket iteration: delivery cancelled", {
          orderId: ticket.order_id,
        });
        break;
      }

      logger.info("Sending escalation ticket", {
        orderId: ticket.order_id,
        assignmentType: ticket.assignment_type,
        targetJid,
        pic: ticket.pic,
        manualMode: Boolean(options.manualMode),
      });
      await enqueueTicketMessage(
        async () => {
          if (isDeliveryCancelled()) {
            logger.warn("Skipping ticket send: delivery cancelled", {
              orderId: ticket.order_id,
            });
            return;
          }

          try {
            await sock.sendMessage(
              targetJid,
              formatEscalationMessagePayload(ticket),
            );
            await markTicketAsSent(ticket, { sourceJid, targetJid });
            sentCount += 1;
            overallSentCount += 1;

            const currentOrder = ticket.order_id || "-";
            const nextTicket = tickets[sentCount];
            const delaySec = Math.round(
              Number(process.env.WA_SEND_DELAY_MS || 20000) / 1000,
            );

            const progressLines = [
              "⏳ **PROGRESS PENGIRIMAN TIKET**",
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
              `📊 **Total Progress** : ${formatProgressBar(overallSentCount, totalTicketsCount)}`,
              `📍 **Target Group**   : ${targetLabel} (${sentCount}/${tickets.length})`,
              "",
              `✅ **Terkirim**       : \`${currentOrder}\``,
              `👤 **PIC**            : **${ticket.pic || "-"}**`,
            ];

            if (nextTicket) {
              progressLines.push(
                `⏳ **Tiket Berikut**  : \`${nextTicket.order_id || "-"}\` (jeda ${delaySec}s...)`,
              );
            } else if (nextEntry) {
              const nextTargetLabel = formatTargetProgressLabel(nextEntry[1]);
              const groupDelaySec = Math.round(
                TARGET_GROUP_COMPLETION_DELAY_MS / 1000,
              );
              progressLines.push(
                `⏳ **Status**         : Lanjut ke **${nextTargetLabel}** (jeda ${groupDelaySec}s...)`,
              );
            }

            await sendTicketProgressMessage(
              sock,
              sourceJid,
              progressLines.join("\n"),
              {
                isProgress: true,
                targetJid,
                targetLabel,
                sentCount,
                totalTickets: tickets.length,
                overallSentCount,
                totalTicketsCount,
              },
            );
          } catch (error) {
            await sendTargetDeliveryFailedAlert(sock, sourceJid, {
              targetJid,
              stage: "ticket detail",
              tickets: [ticket],
              error,
            });
          }
        },
        {
          orderId: ticket.order_id,
          assignmentType: ticket.assignment_type,
          targetJid,
          pic: ticket.pic,
          manualMode: Boolean(options.manualMode),
        },
      );
    }

    if (isDeliveryCancelled()) {
      logger.warn("Stopping target groups: delivery cancelled");
      break;
    }

    if (nextEntry && TARGET_GROUP_COMPLETION_DELAY_MS > 0) {
      const nextTargetLabel = formatTargetProgressLabel(nextEntry[1]);
      const groupDelaySec = Math.round(
        TARGET_GROUP_COMPLETION_DELAY_MS / 1000,
      );

      await sendTicketProgressMessage(
        sock,
        sourceJid,
        [
          "⏳ **PROGRESS PENGIRIMAN TIKET**",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
          `📊 **Total Progress** : ${formatProgressBar(overallSentCount, totalTicketsCount)}`,
          `📍 **Target Selesai** : ${targetLabel} (${sentCount}/${tickets.length})`,
          "",
          `⏳ **Status**         : Menunggu jeda ${groupDelaySec}s sebelum lanjut ke **${nextTargetLabel}**...`,
        ].join("\n"),
        {
          isProgress: true,
          targetJid,
          targetLabel,
          sentCount,
          totalTickets: tickets.length,
          nextTargetLabel,
        },
      );

      logger.info("Waiting before next target group", {
        targetJid,
        targetLabel,
        nextTargetJid: nextEntry[0],
        nextTargetLabel,
        delayMs: TARGET_GROUP_COMPLETION_DELAY_MS,
      });
      await new Promise((resolve) => {
        activeDeliverySleepResolve = resolve;
        activeDeliverySleepTimer = setTimeout(() => {
          activeDeliverySleepTimer = null;
          activeDeliverySleepResolve = null;
          resolve();
        }, TARGET_GROUP_COMPLETION_DELAY_MS);
      });
    }
  }

  if (isDeliveryCancelled()) {
    logger.info("sendTicketDetailsToTargetGroups finished early due to cancellation");
    return;
  }

  await sendTicketProgressMessage(
    sock,
    sourceJid,
    [
      "✅ **PENGIRIMAN TIKET SELESAI**",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `📦 **Total Terkirim** : **${overallSentCount}/${totalTicketsCount} Tiket**`,
      "",
      "🗂️ **Rincian per Target:**",
      ...targetEntries.map(
        ([, tList]) =>
          `• ${formatTargetProgressLabel(tList)}: **${tList.length} tiket**`,
      ),
      "",
      "📋 **Status Pengiriman:**",
      "• Seluruh tiket valid telah berhasil diteruskan ke grup WhatsApp masing-masing.",
      // "• Reminder summary terkirim.",
    ].join("\n"),
    {
      isProgress: true,
      isFinal: true,
    },
  );
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
  if (importOptions.missingCommand) {
    logger.info("Incoming document ignored: caption command is required", {
      sourceJid,
      senderJid,
      fileName: documentMessage.fileName,
    });
    return;
  }

  if (!importOptions.supported) {
    logger.warn("Incoming document rejected: unsupported caption command", {
      sourceJid,
      senderJid,
      command: importOptions.command,
      fileName: documentMessage.fileName,
    });
    await sock.sendMessage(sourceJid, {
      text: [
        "❓ **Command Caption Tidak Dikenal**",
        "",
        `⚙️ Caption yang diterima: ${importOptions.command || "-"}`,
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
    });
    return;
  }
  const accessDecision = getWhatsAppAccessDecision({ sourceJid, senderJid });
  if (!accessDecision.allowed) {
    logger.warn("Incoming Excel rejected: source/sender is not allowed", {
      sourceJid,
      senderJid,
      fileName: documentMessage.fileName,
      reason: accessDecision.reason,
      sourceType: accessDecision.source_type,
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
    text: importOptions.specialMode
      ? [
          "📂 **File Excel Diterima (Mode .special)**",
          "",
          "⏳ Sedang memproses **pengiriman ulang seluruh tiket**...",
        ].join("\n")
      : importOptions.summaryOnlyMode
      ? [
          "📂 **File Excel Diterima (Mode .summary)**",
          "",
          "⏳ Sedang memproses **report dan summary saja**...",
        ].join("\n")
      : importOptions.reminderMode
      ? [
          "📂 **File Excel Diterima (Mode .reminder)**",
          "",
          "⏳ Sedang memproses **pengiriman reminder**...",
        ].join("\n")
      : importOptions.ticketOnlyMode
      ? [
          "📂 **File Excel Diterima (Mode .update)**",
          "",
          "⏳ Sedang memproses **detail tiket saja**...",
        ].join("\n")
      : [
          "📂 **File Excel Diterima**",
          "",
          "⏳ Sedang memproses **tiket lengkap**...",
        ].join("\n"),
  });
  try {
    const buffer = await downloadDocumentBuffer(documentMessage);
    logger.info("Starting ticket Excel process", {
      ticketOnlyMode: importOptions.ticketOnlyMode,
      summaryOnlyMode: importOptions.summaryOnlyMode,
    });
    const result = await processTicketExcel(buffer);
    logger.info("Ticket Excel process completed", {
      total: result.total_rows,
      valid: result.valid_count || 0,
      skipped: result.skipped_count || 0,
      ticketOnlyMode: importOptions.ticketOnlyMode,
      summaryOnlyMode: importOptions.summaryOnlyMode,
    });
    sendImportResult(sock, sourceJid, result, importOptions).catch((err) => {
      logger.error("Failed to process ticket delivery in background", err);
      sock
        .sendMessage(sourceJid, {
          text: [
            "❌ **Gagal Mengirim Tiket ke WhatsApp**",
            "",
            `🛑 Error: ${err.message}`,
          ].join("\n"),
        })
        .catch(() => {});
    });
  } catch (error) {
    logger.error("Failed to process incoming Excel", error);
    await sock.sendMessage(sourceJid, {
      text: [
        "❌ **Gagal Memproses File Excel**",
        "",
        `🛑 Error: ${error.message}`,
        "",
        "👉 Pastikan format file sesuai sebelum mengirim ulang.",
      ].join("\n"),
    });
  }
}

// membuat koneksi Baileys, menangani QR login, reconnect, dan event pesan masuk.
export async function startBot(options = {}) {
  const authDir = options.authDir || AUTH_DIR;
  if (activeController) {
    const status = activeController.getStatus?.();
    if (status?.authDir === authDir) {
      logger.info("WhatsApp bot already started, returning active controller", {
        authDir,
        generation: activeConnectionGeneration,
      });
      return activeController;
    }

    logger.warn("Stopping existing WhatsApp bot before starting new auth dir", {
      currentAuthDir: status?.authDir,
      nextAuthDir: authDir,
    });
    await activeController.stop?.("Switch WhatsApp auth directory");
  }

  const generation = activeConnectionGeneration + 1;
  activeConnectionGeneration = generation;
  let stopRequested = false;
  logger.info("Starting WhatsApp bot auth state", { authDir });
  const localReleaseSessionLock = acquireProcessLock(authDir, "whatsapp-bot");
  releaseSessionLock = localReleaseSessionLock;
  bindSessionLockCleanup();

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version = null;
  let versionSource = "latest";
  try {
    const { version: fetchedVersion } = await fetchLatestBaileysVersion();
    version = fetchedVersion;
  } catch (error) {
    logger.warn("Failed to fetch latest Baileys version from web, falling back to env/default", {
      error: error.message,
    });
  }

  if (!version) {
    const envVersion = parseWaWebVersion(process.env.WA_WEB_VERSION);
    if (envVersion) {
      version = envVersion;
      versionSource = "env";
    }
  }

  if (!version) {
    version = [2, 3000, 1015901307];
    versionSource = "fallback";
  }

  logger.info("Starting WhatsApp socket", {
    waWebVersion: Array.isArray(version) ? version.join(".") : String(version),
    versionSource,
  });

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    version,
    logger: pino({ level: BAILEYS_LOG_LEVEL }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: 60_000,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
    generateHighQualityLinkPreview: false,
    getMessage: async () => ({ conversation: "" }),
  });
  activeSock = sock;

  function isCurrentSocket() {
    return activeConnectionGeneration === generation && activeSock === sock;
  }

  function cleanupCurrentSocket({ releaseLock = true } = {}) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    if (isCurrentSocket()) {
      activeSock = null;
      activeController = null;
    }

    if (releaseLock && releaseSessionLock === localReleaseSessionLock) {
      localReleaseSessionLock?.();
      releaseSessionLock = null;
    }
  }

  const controller = {
    sock,
    getStatus() {
      return {
        running: isCurrentSocket(),
        user: isCurrentSocket() ? sock.user || null : null,
        authDir,
        generation,
      };
    },
    async stop(reason = "Manual stop") {
      logger.info("Stopping WhatsApp bot socket", { reason, authDir, generation });
      stopRequested = true;
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("creds.update");
        sock.end?.(new Error(reason));
      } catch (error) {
        logger.warn("WhatsApp socket stop raised an error", {
          message: error.message,
          authDir,
          generation,
        });
      }
      cleanupCurrentSocket();
    },
    async logout(reason = "Telegram logout") {
      logger.info("Logging out WhatsApp bot", { reason, authDir, generation });
      stopRequested = true;
      if (sock.logout) {
        await sock.logout(reason);
      }
      cleanupCurrentSocket();
    },
  };
  activeController = controller;
  options.onControllerUpdate?.(controller);

  sock.ev.on("creds.update", saveCreds);
  bindCommandIndexEvents(sock);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (activeConnectionGeneration !== generation) {
      logger.warn("Ignoring stale WhatsApp connection update", {
        connection,
        authDir,
        generation,
        activeGeneration: activeConnectionGeneration,
      });
      return;
    }

    options.onConnectionUpdate?.({ connection, lastDisconnect, qr });

    if (qr) {
      logger.info(
        "QR login received. Scan from WhatsApp > Linked devices > Link a device",
      );
      options.onQr?.(qr);
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      logger.info("WhatsApp bot connected", { authDir, generation });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason =
        lastDisconnect?.error?.output?.payload?.message ||
        lastDisconnect?.error?.message;
      const isManagedBySessionService = Boolean(options.onConnectionUpdate);
      const shouldReconnect =
        !stopRequested &&
        statusCode !== DisconnectReason.loggedOut &&
        !isManagedBySessionService;

      if (shouldReconnect) {
        logger.warn("WhatsApp connection closed, reconnecting in 5 seconds", {
          statusCode: statusCode || "unknown",
          reason: reason || "no reason",
          authDir,
          generation,
        });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (activeConnectionGeneration !== generation || stopRequested) {
            logger.warn("Skipping stale WhatsApp reconnect timer", {
              authDir,
              generation,
              activeGeneration: activeConnectionGeneration,
              stopRequested,
            });
            return;
          }

          cleanupCurrentSocket();
          startBot(options).catch((error) => {
            logger.error("Failed to reconnect WhatsApp bot", error);
          });
        }, 5000);
      } else {
        cleanupCurrentSocket();
        logger.warn(
          "WhatsApp connection closed",
          {
            authDir,
            generation,
            statusCode,
            reason,
            managedBySessionService: isManagedBySessionService,
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

  return activeController;
}
