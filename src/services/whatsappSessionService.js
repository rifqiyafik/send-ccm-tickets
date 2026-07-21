import fs from "node:fs/promises";
import qrcode from "qrcode-terminal";

import { startBot } from "../handlers/whatsappMessageHandler.js";
import { createLogger } from "../utils/logger.js";
import { escapeTelegramHtml } from "../utils/telegramFormat.js";

const logger = createLogger("whatsappSessionService");
const AUTH_DIR = process.env.WA_AUTH_DIR || "sessions/baileys";

function formatQrText(qr) {
  let qrText = "";
  qrcode.generate(qr, { small: true }, (output) => {
    qrText = output;
  });
  return qrText;
}

// #penjelasan: membungkus lifecycle WhatsApp agar bisa dikontrol dari Telegram tanpa command terminal.
export function createWhatsAppSessionService({ sendTelegramMessage }) {
  let controller = null;
  const qrSubscribers = new Set();

  async function notifySubscribers(text, options = {}) {
    for (const chatId of qrSubscribers) {
      await sendTelegramMessage(chatId, text, options);
    }
  }

  async function notifyQr(qr) {
    logger.info("Forwarding WhatsApp QR to Telegram subscribers", {
      subscribers: qrSubscribers.size,
    });
    const qrText = formatQrText(qr);
    await notifySubscribers(
      [
        "WhatsApp login QR diterima.",
        "Scan dari WhatsApp > Linked devices > Link a device.",
        "",
        `<pre>${escapeTelegramHtml(qrText)}</pre>`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  async function login(chatId) {
    logger.info("WhatsApp login requested from Telegram", { chatId });
    if (chatId) {
      qrSubscribers.add(String(chatId));
    }

    if (controller?.getStatus?.().running) {
      const status = controller.getStatus();
      return [
        "WhatsApp bot sudah berjalan.",
        `User: ${status.user?.id || status.user?.name || "-"}`,
        `Auth dir: ${status.authDir}`,
      ].join("\n");
    }

    controller = await startBot({
      onQr: notifyQr,
      onConnectionUpdate: async ({ connection }) => {
        if (connection === "open") {
          await notifySubscribers("✅ WhatsApp Bot Connected");
        }
        if (connection === "close") {
          await notifySubscribers("❌ WhatsApp Connection Closed");
        }
      },
    });

    return [
      "🔐 **WhatsApp Login Dimulai**",
      "",
      "⏳ Jika session belum aktif, QR akan dikirim ke chat Telegram ini.",
      `📂 Auth Directory: ${AUTH_DIR}`,
      "",
      "---",
      "ℹ️ Scan QR segera untuk mengaktifkan session WhatsApp.",
    ].join("\n");
  }

  async function logout() {
    logger.info("WhatsApp logout requested from Telegram", {
      authDir: AUTH_DIR,
    });
    if (controller?.logout) {
      await controller.logout("Telegram /logout");
    }
    controller = null;
    await fs.rm(AUTH_DIR, { recursive: true, force: true });

    return [
      "❌ WhatsApp Session Logout",
      `Folder session dibersihkan: ${AUTH_DIR}`,
      "Jalankan /login untuk scan QR baru.",
    ].join("\n");
  }

  function getStatus() {
    const status = controller?.getStatus?.() || {
      running: false,
      user: null,
      authDir: AUTH_DIR,
    };

    return {
      ...status,
      qr_subscribers: qrSubscribers.size,
    };
  }

  function getSocket() {
    return controller?.sock || null;
  }

  return {
    getSocket,
    getStatus,
    login,
    logout,
  };
}
