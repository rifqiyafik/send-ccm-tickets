import "dotenv/config";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { createLogger } from "../src/utils/logger.js";
import { cleanInlineText } from "../src/utils/text.js";
import { acquireProcessLock } from "../src/utils/processLock.js";

const AUTH_DIR = process.env.WA_AUTH_DIR || "sessions/baileys";
const BAILEYS_LOG_LEVEL = process.env.BAILEYS_LOG_LEVEL || "silent";
const MAX_RESULT = Number(process.env.JID_SEARCH_LIMIT || 50);
const MAX_MESSAGE_LENGTH = 3500;
const logger = createLogger("jidSearchBot");

const groupIndex = new Map();
const privateIndex = new Map();
let reconnectTimer = null;
let releaseSessionLock = null;

// #penjelasan: melepas lock session saat script JID dihentikan normal dari terminal.
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

// #penjelasan: membaca versi WhatsApp Web dari env jika fetchLatestBaileysVersion memberi versi yang tidak cocok.
function parseWaWebVersion(value) {
  const version = String(value || "")
    .split(".")
    .map((item) => Number(item.trim()));

  return version.length === 3 && version.every(Number.isInteger) ? version : null;
}

// #penjelasan: memberi batas waktu untuk operasi async agar log tidak terlihat berhenti tanpa penyebab.
function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

// #penjelasan: mengambil teks command dari beberapa jenis pesan WhatsApp yang umum.
function getMessageText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  ).trim();
}

// #penjelasan: memastikan pencarian tidak sensitif kapital dan spasi.
function normalizeSearch(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// #penjelasan: mengambil keyword setelah command, contoh ".groups nop" menjadi "nop".
function parseCommand(text) {
  const [command = "", ...parts] = text.trim().split(/\s+/);
  return {
    command: command.toLowerCase(),
    keyword: normalizeSearch(parts.join(" ")),
  };
}

// #penjelasan: menentukan apakah JID adalah grup WhatsApp.
function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

// #penjelasan: menentukan apakah JID adalah private chat WhatsApp.
function isPrivateJid(jid) {
  const text = String(jid || "");
  return text.endsWith("@s.whatsapp.net") || text.endsWith("@lid");
}

// #penjelasan: menormalkan JID user agar device id seperti 628xx:12@s.whatsapp.net tidak mengganggu pengecekan owner.
function normalizeUserJid(jid) {
  const text = String(jid || "");
  const [user = "", server = ""] = text.split("@");
  const normalizedUser = user.split(":")[0];

  return normalizedUser && server ? `${normalizedUser}@${server}` : text;
}

// #penjelasan: mengambil JID akun bot dari session Baileys.
function getBotJid(sock) {
  return normalizeUserJid(sock.user?.id || "");
}

// #penjelasan: mengumpulkan semua identitas akun bot yang mungkin muncul sebagai @s.whatsapp.net atau @lid.
function getBotIdentityJids(sock) {
  return new Set(
    [
      sock.user?.id,
      sock.user?.lid,
      sock.user?.jid,
      sock.authState?.creds?.me?.id,
      sock.authState?.creds?.me?.lid,
    ]
      .map(normalizeUserJid)
      .filter(Boolean),
  );
}

// #penjelasan: membaca daftar owner tambahan dari env OWNER_JIDS jika nanti bot dipakai oleh nomor admin lain.
function getOwnerJids(sock) {
  const ownerJids = getBotIdentityJids(sock);
  const envOwnerJids = String(process.env.OWNER_JIDS || "")
    .split(",")
    .map((jid) => normalizeUserJid(jid.trim()))
    .filter(Boolean);

  for (const jid of envOwnerJids) {
    ownerJids.add(jid);
  }

  return ownerJids;
}

// #penjelasan: JID lengkap hanya boleh diminta dari private chat owner, idealnya chat ke nomor sendiri.
function isAuthorizedJidRequest(sock, message) {
  const sourceJid = normalizeUserJid(message.key.remoteJid);
  const senderJid = normalizeUserJid(message.key.participant || sourceJid);
  const ownerJids = getOwnerJids(sock);
  const isPrivateSource = isPrivateJid(sourceJid);

  if (message.key.fromMe) {
    return isPrivateSource;
  }

  return isPrivateSource && (ownerJids.has(sourceJid) || ownerJids.has(senderJid));
}

// #penjelasan: menyimpan metadata grup ke index lokal agar bisa dicari cepat.
function upsertGroup(jid, data = {}) {
  if (!isGroupJid(jid)) {
    return;
  }

  groupIndex.set(jid, {
    jid,
    name: cleanInlineText(data.subject || data.name || data.notify || jid),
    participants: Array.isArray(data.participants) ? data.participants.length : undefined,
  });
}

// #penjelasan: menyimpan private JID yang tersinkron/terdeteksi dari event Baileys.
function upsertPrivate(jid, data = {}) {
  if (!isPrivateJid(jid)) {
    return;
  }

  const existing = privateIndex.get(jid) || {};
  privateIndex.set(jid, {
    jid,
    name: cleanInlineText(
      data.name ||
        data.notify ||
        data.verifiedName ||
        data.pushName ||
        existing.name ||
        jid,
    ),
  });
}

// #penjelasan: mencocokkan keyword ke nama atau JID.
function matchesSearch(item, keyword) {
  if (!keyword) {
    return true;
  }

  return (
    normalizeSearch(item.name).includes(keyword) ||
    normalizeSearch(item.jid).includes(keyword)
  );
}

// #penjelasan: membuat teks daftar JID yang mudah disalin ke config, maksimal 10 baris per request.
function formatList({ label, items, keyword }) {
  const matched = items
    .filter((item) => matchesSearch(item, keyword))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shown = matched.slice(0, MAX_RESULT);

  if (shown.length === 0) {
    return `${label} (0 total, showing 0):${keyword ? `\nFilter: ${keyword}` : ""}\n\nTidak ada hasil.`;
  }

  return [
    `${label} (${matched.length} total, showing ${shown.length}):`,
    ...shown.map((item) => `- ${item.jid} - ${item.name}`),
  ]
    .filter(Boolean)
    .join("\n");
}

// #penjelasan: memecah pesan panjang agar tidak gagal dikirim oleh WhatsApp.
async function sendLongText(sock, jid, text) {
  for (let index = 0; index < text.length; index += MAX_MESSAGE_LENGTH) {
    await sock.sendMessage(jid, {
      text: text.slice(index, index + MAX_MESSAGE_LENGTH),
    });
  }
}

// #penjelasan: mengambil ulang grup dari akun bot; ini sumber paling akurat untuk JID grup.
async function refreshGroups(sock) {
  logger.info("Refreshing group metadata");
  const groups = await sock.groupFetchAllParticipating();

  for (const [jid, metadata] of Object.entries(groups)) {
    upsertGroup(jid, metadata);
  }

  logger.info("Group metadata refreshed", { groups: groupIndex.size });
}

// #penjelasan: menampilkan bantuan command untuk search JID.
function formatHelp() {
  return [
    "JID Search Bot",
    "",
    "Command:",
    ".groups",
    ".groups nop",
    ".private",
    ".private ferry",
    ".help",
    "",
    "Catatan:",
    "- Hasil dikirim sebagai pesan WhatsApp, bukan terminal.",
    "- JID hanya ditampilkan jika command dikirim dari private chat owner/self-chat.",
    `- .groups mengambil grup yang diikuti akun bot dan menampilkan maksimal ${MAX_RESULT} baris.`,
    `- .private hanya menampilkan private chat/kontak yang tersinkron atau pernah terdeteksi oleh session, maksimal ${MAX_RESULT} baris.`,
    "- JID private untuk mention biasanya formatnya 628xxxx@s.whatsapp.net.",
  ].join("\n");
}

// #penjelasan: menjalankan command search JID dari pesan WhatsApp.
async function handleCommand(sock, messageEvent) {
  const message = messageEvent.messages?.[0];
  if (!message?.message) {
    return;
  }

  const sourceJid = message.key.remoteJid;
  const senderJid = message.key.participant || sourceJid;
  const text = getMessageText(message.message);
  const pushName = message.pushName;

  upsertPrivate(senderJid, { pushName });
  if (isPrivateJid(sourceJid)) {
    upsertPrivate(sourceJid, { pushName });
  }

  if (!text.startsWith(".")) {
    return;
  }

  const { command, keyword } = parseCommand(text);
  logger.info("Incoming JID search command", { sourceJid, senderJid, command, keyword });

  if (![".help", ".groups", ".private"].includes(command)) {
    return;
  }

  if (!isAuthorizedJidRequest(sock, message)) {
    logger.warn("JID search command rejected: unauthorized source", {
      sourceJid,
      senderJid,
      fromMe: message.key.fromMe,
      botJid: getBotJid(sock),
      botIdentityJids: [...getBotIdentityJids(sock)],
    });

    if (!isGroupJid(sourceJid)) {
      await sock.sendMessage(sourceJid, {
        text: "Command JID hanya bisa dipakai oleh owner di chat pribadi/self-chat bot.",
      });
    }
    return;
  }

  if (command === ".help") {
    await sock.sendMessage(sourceJid, { text: formatHelp() });
    return;
  }

  if (command === ".groups") {
    await refreshGroups(sock);
    await sendLongText(
      sock,
      sourceJid,
      formatList({
        label: "WhatsApp groups",
        items: [...groupIndex.values()],
        keyword,
      }),
    );
    return;
  }

  if (command === ".private") {
    await sendLongText(
      sock,
      sourceJid,
      formatList({
        label: "WhatsApp private chats",
        items: [...privateIndex.values()],
        keyword,
      }),
    );
    return;
  }
}

// #penjelasan: menghubungkan event Baileys ke index group/private agar data makin lengkap.
function bindIndexEvents(sock) {
  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of contacts) {
      upsertPrivate(contact.id, contact);
    }
    logger.info("Contacts index updated", { privateChats: privateIndex.size });
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const chat of chats) {
      if (isGroupJid(chat.id)) {
        upsertGroup(chat.id, chat);
      } else {
        upsertPrivate(chat.id, chat);
      }
    }
    logger.info("Chats index upserted", {
      groups: groupIndex.size,
      privateChats: privateIndex.size,
    });
  });

  sock.ev.on("chats.update", (chats) => {
    for (const chat of chats) {
      if (isGroupJid(chat.id)) {
        upsertGroup(chat.id, chat);
      } else {
        upsertPrivate(chat.id, chat);
      }
    }
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

    logger.info("Messaging history indexed", {
      groups: groupIndex.size,
      privateChats: privateIndex.size,
    });
  });
}

// #penjelasan: membuat koneksi Baileys khusus search JID dengan QR login dan reconnect.
async function startJidSearchBot() {
  logger.info("Starting JID search bot", { authDir: AUTH_DIR });
  releaseSessionLock = acquireProcessLock(AUTH_DIR, "jid-search-bot");
  bindSessionLockCleanup();

  logger.info("Loading Baileys auth state");
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  logger.info("Baileys auth state loaded", {
    registered: Boolean(state.creds?.registered),
  });

  const envVersion = parseWaWebVersion(process.env.WA_WEB_VERSION);
  logger.info(envVersion ? "Using WhatsApp Web version from env" : "Fetching latest WhatsApp Web version");
  let version;
  try {
    if (envVersion) {
      version = envVersion;
    } else {
      const versionResult = await withTimeout(
        fetchLatestBaileysVersion(),
        15000,
        "fetchLatestBaileysVersion",
      );
      version = versionResult.version;
    }
    logger.info("WhatsApp Web version resolved", {
      version: version.join("."),
      versionSource: envVersion ? "env" : "latest",
    });
  } catch (error) {
    logger.warn("Failed to fetch latest WhatsApp Web version, using Baileys default", {
      message: error.message,
    });
  }

  logger.info("Creating Baileys socket");
  const socketOptions = {
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: BAILEYS_LOG_LEVEL }),
    syncFullHistory: true,
  };

  if (version) {
    socketOptions.version = version;
  }

  const sock = makeWASocket(socketOptions);
  logger.info("Baileys socket created, waiting for connection update");

  bindIndexEvents(sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info("QR login received. Scan from WhatsApp > Linked devices > Link a device");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      logger.info("JID search bot connected");
      refreshGroups(sock).catch((error) => {
        logger.error("Failed to refresh groups after connect", error);
      });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason =
        lastDisconnect?.error?.output?.payload?.message ||
        lastDisconnect?.error?.message ||
        "no reason";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        logger.warn("JID search bot disconnected, reconnecting in 5 seconds", {
          statusCode: statusCode || "unknown",
          reason,
          registered: Boolean(sock.authState?.creds?.registered),
        });
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          startJidSearchBot().catch((error) => {
            logger.error("Failed to reconnect JID search bot", error);
          });
        }, 5000);
      } else {
        logger.warn("JID search bot logged out. Delete session and scan a new QR", {
          authDir: AUTH_DIR,
        });
      }
    }
  });

  sock.ev.on("messages.upsert", (messageEvent) => {
    handleCommand(sock, messageEvent).catch((error) => {
      logger.error("Failed to handle JID search command", error);
    });
  });
}

startJidSearchBot().catch((error) => {
  logger.error("Failed to start JID search bot", error);
  process.exit(1);
});
