import fs from "node:fs/promises";
import qrcode from "qrcode-terminal";

import { startBot } from "../handlers/whatsappMessageHandler.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("whatsappSessionService");
const AUTH_DIR = process.env.WA_AUTH_DIR || "sessions/baileys";

function formatQrText(qr) {
  let qrText = "";
  qrcode.generate(qr, { small: true }, (output) => {
    qrText = output;
  });
  return qrText;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// #penjelasan: membungkus lifecycle WhatsApp agar bisa dikontrol dari Telegram tanpa command terminal.
export function createWhatsAppSessionService({ sendTelegramMessage }) {
  let controller = null;
  const qrSubscribers = new Set();

  async function notifySubscribers(text) {
    for (const chatId of qrSubscribers) {
      await sendTelegramMessage(chatId, text);
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
        `<pre>${escapeHtml(qrText)}</pre>`,
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
          await notifySubscribers("WhatsApp bot connected.");
        }
        if (connection === "close") {
          await notifySubscribers("WhatsApp connection closed.");
        }
      },
    });

    return [
      "WhatsApp login dimulai.",
      "Jika session belum aktif, QR akan dikirim ke chat Telegram ini.",
      `Auth dir: ${AUTH_DIR}`,
    ].join("\n");
  }

  async function logout() {
    logger.info("WhatsApp logout requested from Telegram", { authDir: AUTH_DIR });
    if (controller?.logout) {
      await controller.logout("Telegram /logout");
    }
    controller = null;
    await fs.rm(AUTH_DIR, { recursive: true, force: true });

    return [
      "WhatsApp session sudah logout.",
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

  return {
    getStatus,
    login,
    logout,
  };
}
