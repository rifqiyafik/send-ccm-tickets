import qrcode from "qrcode-terminal";

import { startBot } from "../handlers/whatsappMessageHandler.js";
import { createLogger } from "../utils/logger.js";
import { escapeTelegramHtml } from "../utils/telegramFormat.js";
import {
  deleteWhatsAppSession,
  formatWhatsAppSessionsList,
  getWhatsAppSessionRegistry,
  isValidPhoneNumber,
  listWhatsAppSessions,
  markWhatsAppSessionStatus,
  normalizePhoneNumber,
  resolveWhatsAppSession,
  upsertWhatsAppSession,
} from "./whatsappSessionRegistryService.js";

const logger = createLogger("whatsappSessionService");
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;

function formatQrText(qr) {
  let qrText = "";
  qrcode.generate(qr, { small: true }, (output) => {
    qrText = output;
  });
  return qrText;
}

function formatSessionLine(session) {
  if (!session) {
    return "-";
  }

  return `${session.label} (${session.phone})`;
}

// #penjelasan: membungkus lifecycle WhatsApp agar bisa dikontrol dari Telegram tanpa command terminal.
export function createWhatsAppSessionService({ sendTelegramMessage }) {
  let controller = null;
  let activeSession = null;
  const qrSubscribers = new Set();
  const pendingLoginNames = new Map();

  async function notifySubscribers(text, options = {}) {
    for (const chatId of qrSubscribers) {
      await sendTelegramMessage(chatId, text, options);
    }
  }

  async function notifyQr(qr) {
    logger.info("Forwarding WhatsApp QR to Telegram subscribers", {
      subscribers: qrSubscribers.size,
      activeSessionId: activeSession?.id,
    });
    const qrText = formatQrText(qr);
    await notifySubscribers(
      [
        "📱 <b>WhatsApp Login QR</b>",
        "",
        `Session: <b>${escapeTelegramHtml(formatSessionLine(activeSession))}</b>`,
        "",
        "Scan dari <b>WhatsApp › Linked Devices › Link a Device</b>",
        "",
        `<pre>${escapeTelegramHtml(qrText)}</pre>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  async function startSession(session, chatId) {
    if (chatId) {
      qrSubscribers.add(String(chatId));
    }

    if (controller?.getStatus?.().running) {
      if (activeSession?.id === session.id) {
        const status = controller.getStatus();
        return [
          "✅ WhatsApp session sudah berjalan.",
          "",
          `Session: **${session.label}**`,
          `Phone: \`${session.phone}\``,
          `User: \`${status.user?.id || status.user?.name || "-"}\``,
          `Auth dir: \`${status.authDir}\``,
        ].join("\n");
      }

      logger.info("Stopping active session before switching session", {
        activeSessionId: activeSession?.id,
        nextSessionId: session.id,
      });
      await controller.stop("Switch WhatsApp session");
      if (activeSession?.id) {
        await markWhatsAppSessionStatus(activeSession.id, "stopped");
      }
      controller = null;
    }

    activeSession = await markWhatsAppSessionStatus(session.id, "starting");
    controller = await startBot({
      authDir: session.auth_dir,
      onQr: notifyQr,
      onConnectionUpdate: async ({ connection }) => {
        if (connection === "open") {
          await markWhatsAppSessionStatus(session.id, "connected");
          await notifySubscribers(
            [
              "✅ <b>WhatsApp Bot Connected</b>",
              "",
              `Session: <b>${escapeTelegramHtml(session.label)}</b>`,
              `Phone: <code>${escapeTelegramHtml(session.phone)}</code>`,
            ].join("\n"),
            { parse_mode: "HTML" },
          );
        }
        if (connection === "close") {
          await markWhatsAppSessionStatus(session.id, "stopped");
          await notifySubscribers(
            [
              "❌ <b>WhatsApp Connection Closed</b>",
              "",
              `Session: <b>${escapeTelegramHtml(session.label)}</b>`,
            ].join("\n"),
            { parse_mode: "HTML" },
          );
        }
      },
    });

    return [
      "🔐 **WhatsApp Login Dimulai**",
      "",
      `Session: **${session.label}**`,
      `Phone: \`${session.phone}\``,
      `Auth Directory: \`${session.auth_dir}\``,
      "",
      "Jika credential masih valid, session akan langsung connected.",
      "Jika belum valid, QR akan dikirim ke chat Telegram ini.",
    ].join("\n");
  }

  async function login(chatId, argument = "") {
    logger.info("WhatsApp login requested from Telegram", {
      chatId,
      argument,
    });
    if (chatId) {
      qrSubscribers.add(String(chatId));
    }

    const value = String(argument || "").trim();
    const registry = await getWhatsAppSessionRegistry();
    const sessions = await listWhatsAppSessions();

    if (!value) {
      return formatWhatsAppSessionsList({
        sessions,
        activeSessionId: registry.active_session_id,
        title: "📱 Session WhatsApp tersedia",
      });
    }

    if (isValidPhoneNumber(value)) {
      const phone = normalizePhoneNumber(value);
      pendingLoginNames.set(String(chatId), {
        phone,
        expiresAt: Date.now() + PENDING_LOGIN_TTL_MS,
      });
      return [
        "📝 **Nama Session Baru**",
        "",
        `Nomor: \`${phone}\``,
        "",
        "Apa nama session baru yang akan dibuat ini?",
        "",
        "Balas langsung dengan nama session.",
        "Contoh: `Budi`",
        "",
        "⏱️ Pending login berlaku 5 menit.",
      ].join("\n");
    }

    const session = await resolveWhatsAppSession(value);
    if (!session) {
      return [
        "⚠️ **Session Tidak Ditemukan**",
        "",
        `Input: \`${value}\``,
        "",
        "Jalankan `/sessions` untuk melihat nomor urut session.",
        "Atau jalankan `/login nomor_hp` untuk membuat session baru.",
      ].join("\n");
    }

    return startSession(session, chatId);
  }

  async function completePendingLoginName(chatId, label) {
    const key = String(chatId);
    const pending = pendingLoginNames.get(key);
    if (!pending) {
      return null;
    }

    if (Date.now() > pending.expiresAt) {
      pendingLoginNames.delete(key);
      return [
        "⌛ **Pending Login Expired**",
        "",
        "Jalankan ulang `/login nomor_hp` untuk membuat session baru.",
      ].join("\n");
    }

    const sessionLabel = String(label || "").trim();
    if (!sessionLabel) {
      return [
        "⚠️ Nama session tidak boleh kosong.",
        "",
        "Balas dengan nama session, contoh: `Budi`",
      ].join("\n");
    }

    pendingLoginNames.delete(key);
    const session = await upsertWhatsAppSession({
      phone: pending.phone,
      label: sessionLabel,
      status: "saved",
    });

    return startSession(session, chatId);
  }

  async function listSessions() {
    const registry = await getWhatsAppSessionRegistry();
    return formatWhatsAppSessionsList({
      sessions: await listWhatsAppSessions(),
      activeSessionId: registry.active_session_id,
    });
  }

  async function startSavedSession(chatId) {
    const registry = await getWhatsAppSessionRegistry();
    const sessions = await listWhatsAppSessions();
    const session =
      sessions.find((item) => item.id === registry.active_session_id) ||
      sessions[0];

    if (!session) {
      return formatWhatsAppSessionsList({
        sessions,
        activeSessionId: registry.active_session_id,
      });
    }

    return startSession(session, chatId);
  }

  async function stop(selector = "") {
    const registry = await getWhatsAppSessionRegistry();
    const sessions = await listWhatsAppSessions();
    const value = String(selector || "").trim();

    if (!value) {
      return [
        formatWhatsAppSessionsList({
          sessions,
          activeSessionId: registry.active_session_id,
          title: "🛑 Stop WhatsApp Session",
        }),
        "",
        "Stop session hanya mematikan socket bot.",
        "Credential tetap aman dan bisa dipakai lagi tanpa scan QR jika masih valid.",
        "",
        "Jalankan `/stop 1` untuk mematikan koneksi session aktif.",
      ].join("\n");
    }

    const session = await resolveWhatsAppSession(value);
    if (!session) {
      return [
        "⚠️ **Session Tidak Ditemukan**",
        "",
        `Input: \`${value}\``,
        "Jalankan `/sessions` untuk melihat daftar session.",
      ].join("\n");
    }

    if (!controller?.getStatus?.().running || activeSession?.id !== session.id) {
      return [
        "ℹ️ **Session Tidak Sedang Aktif**",
        "",
        `Session: **${session.label}**`,
        `Phone: \`${session.phone}\``,
        "",
        "Tidak ada koneksi aktif yang perlu dimatikan untuk session ini.",
      ].join("\n");
    }

    await controller.stop("Telegram /stop");
    controller = null;
    await markWhatsAppSessionStatus(session.id, "stopped");

    return [
      "🛑 **WhatsApp Session Stopped**",
      "",
      `Session: **${session.label}**`,
      `Phone: \`${session.phone}\``,
      "",
      "Credential lokal tetap disimpan.",
      "Jalankan `/login 1` untuk mengaktifkan kembali.",
    ].join("\n");
  }

  async function logout(selector = "") {
    const session = selector
      ? await resolveWhatsAppSession(selector)
      : activeSession;

    logger.info("WhatsApp logout requested from Telegram", {
      selector,
      sessionId: session?.id,
      activeSessionId: activeSession?.id,
    });

    if (!session) {
      return [
        "⚠️ **Session Logout Tidak Ditemukan**",
        "",
        "Jalankan `/sessions` untuk melihat daftar session.",
      ].join("\n");
    }

    if (!controller?.logout || activeSession?.id !== session.id) {
      return [
        "⚠️ **Logout hanya bisa untuk session yang sedang aktif.**",
        "",
        `Session: **${session.label}**`,
        `Phone: \`${session.phone}\``,
        "",
        "Jalankan `/login <nomor_urut>` dulu jika ingin logout session ini.",
        "Untuk hanya menghapus file lokal, gunakan `/delete_session <nomor_urut>`.",
      ].join("\n");
    }

    await controller.logout("Telegram /logout");
    controller = null;
    await markWhatsAppSessionStatus(session.id, "logged_out");

    return [
      "🚪 **WhatsApp Session Logout**",
      "",
      `Session: **${session.label}**`,
      `Phone: \`${session.phone}\``,
      "",
      "Linked device diputus dari WhatsApp.",
      "Credential lokal tidak dihapus otomatis.",
      "Gunakan `/delete_session 1` jika ingin membersihkan file lokal.",
    ].join("\n");
  }

  async function deleteSession(selector) {
    const session = await resolveWhatsAppSession(selector);
    if (!session) {
      return [
        "⚠️ **Session Tidak Ditemukan**",
        "",
        `Input: \`${selector || "-"}\``,
        "Jalankan `/sessions` untuk melihat daftar session.",
      ].join("\n");
    }

    if (controller?.getStatus?.().running && activeSession?.id === session.id) {
      await controller.stop("Delete active WhatsApp session");
      controller = null;
    }

    await deleteWhatsAppSession(selector);
    if (activeSession?.id === session.id) {
      activeSession = null;
    }

    return [
      "🗑️ **WhatsApp Session Deleted**",
      "",
      `Session: **${session.label}**`,
      `Phone: \`${session.phone}\``,
      `Auth dir: \`${session.auth_dir}\``,
      "",
      "File credential lokal sudah dihapus.",
      "Jika ingin revoke dari sisi WhatsApp, hapus juga dari WhatsApp > Linked Devices.",
    ].join("\n");
  }

  function getStatus() {
    const status = controller?.getStatus?.() || {
      running: false,
      user: null,
      authDir: activeSession?.auth_dir || "",
    };

    return {
      ...status,
      active_session: activeSession,
      qr_subscribers: qrSubscribers.size,
    };
  }

  function getSocket() {
    return controller?.sock || null;
  }

  return {
    completePendingLoginName,
    deleteSession,
    getSocket,
    getStatus,
    listSessions,
    login,
    logout,
    startSavedSession,
    stop,
  };
}
