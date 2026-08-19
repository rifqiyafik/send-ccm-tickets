import fs from "node:fs/promises";
import QRCode from "qrcode";
import qrcode from "qrcode-terminal";

import { startBot } from "../handlers/whatsappMessageHandler.js";
import { createLogger } from "../utils/logger.js";
import { escapeTelegramHtml } from "../utils/telegramFormat.js";
import { releaseProcessLockByDir } from "../utils/processLock.js";
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
const PENDING_SESSION_SWITCH_TTL_MS = 2 * 60 * 1000;
const PENDING_REAUTH_TTL_MS = 5 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = Number(
  process.env.WA_READY_TIMEOUT_MS || 30000,
);
const AUTO_RECOVER_DELAY_MS = Number(
  process.env.WA_AUTO_RECOVER_DELAY_MS || 7000,
);
const WA_LOGGED_OUT_STATUS_CODE = 401;
const WA_FORBIDDEN_STATUS_CODE = 403;
const MAX_QR_NOTIFY_COUNT = 3;

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
export function createWhatsAppSessionService({
  sendTelegramMessage,
  sendTelegramPhoto,
  startWhatsAppBot = startBot,
}) {
  let controller = null;
  let activeSession = null;
  let desiredSessionId = "";
  let connectionState = "stopped";
  let autoRecoverTimer = null;
  let qrNotifyCount = 0;
  const qrSubscribers = new Set();
  const pendingLoginNames = new Map();
  const pendingSessionSwitches = new Map();
  const pendingExpiredSessionReauth = new Map();
  const readyWaiters = new Set();

  async function notifySubscribers(text, options = {}) {
    for (const chatId of qrSubscribers) {
      await sendTelegramMessage(chatId, text, options);
    }
  }

  async function notifySubscribersPhoto(photoBuffer, caption, options = {}) {
    for (const chatId of qrSubscribers) {
      if (sendTelegramPhoto) {
        try {
          await sendTelegramPhoto(chatId, photoBuffer, { caption, ...options });
          continue;
        } catch (error) {
          logger.warn("Failed to send QR photo to subscriber, falling back to text", {
            chatId,
            error: error.message,
          });
        }
      }
      await sendTelegramMessage(chatId, caption, options);
    }
  }

  async function notifyQr(qr) {
    qrNotifyCount += 1;
    logger.info("Forwarding WhatsApp QR to Telegram subscribers", {
      subscribers: qrSubscribers.size,
      activeSessionId: activeSession?.id,
      qrCount: qrNotifyCount,
      maxQrCount: MAX_QR_NOTIFY_COUNT,
    });

    if (qrNotifyCount > MAX_QR_NOTIFY_COUNT) {
      logger.warn("QR notify limit reached, stopping QR session", {
        sessionId: activeSession?.id,
        qrNotifyCount,
      });
      await notifySubscribers(
        [
          "⌛ <b>Sesi Scan QR Berakhir</b>",
          "",
          `Session: <b>${escapeTelegramHtml(formatSessionLine(activeSession))}</b>`,
          "",
          `QR Code sudah dikirim <b>${MAX_QR_NOTIFY_COUNT} kali</b> tanpa di-scan.`,
          "Sesi login QR dihentikan otomatis untuk keamanan.",
          "",
          "Ketik <code>/login &lt;nomor_urut&gt;</code> jika ingin mencoba kembali.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      // Stop the socket without triggering auto-recover
      if (controller?.getStatus?.().running) {
        desiredSessionId = "";
        clearAutoRecoverTimer();
        await controller.stop("QR notify limit reached");
        controller = null;
        connectionState = "stopped";
        if (activeSession) {
          await markWhatsAppSessionStatus(activeSession.id, "stopped");
        }
      }
      return;
    }

    const caption = [
      "📱 <b>WhatsApp Login QR</b>",
      "",
      `Session: <b>${escapeTelegramHtml(formatSessionLine(activeSession))}</b>`,
      "",
      "Scan dari <b>WhatsApp › Linked Devices › Link a Device</b>",
      "",
      `<i>QR ${qrNotifyCount}/${MAX_QR_NOTIFY_COUNT} — Ketik /cancel untuk membatalkan.</i>`,
    ].join("\n");

    let qrImageBuffer = null;
    try {
      qrImageBuffer = await QRCode.toBuffer(qr, {
        type: "png",
        margin: 2,
        scale: 8,
      });
    } catch (error) {
      logger.error("Failed to generate QR image buffer", error);
    }

    if (qrImageBuffer && sendTelegramPhoto) {
      await notifySubscribersPhoto(qrImageBuffer, caption, { parse_mode: "HTML" });
    } else {
      const qrText = formatQrText(qr);
      await notifySubscribers(
        [
          caption,
          "",
          `<pre>${escapeTelegramHtml(qrText)}</pre>`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    }
  }

  function isSessionRunning() {
    return (
      Boolean(controller?.getStatus?.().running) &&
      connectionState === "connected"
    );
  }

  function resolveSocketReady() {
    for (const waiter of readyWaiters) {
      waiter.resolve(true);
    }
    readyWaiters.clear();
  }

  function rejectSocketReady(error) {
    for (const waiter of readyWaiters) {
      waiter.reject(error);
    }
    readyWaiters.clear();
  }

  function waitForConnection(timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
    if (isSessionRunning() && connectionState === "connected") {
      return Promise.resolve(true);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: null,
        reject: null,
        timeout: null,
      };

      waiter.timeout = setTimeout(() => {
        readyWaiters.delete(waiter);
        reject(
          new Error(
            `WhatsApp session belum connected setelah ${Math.round(
              timeoutMs / 1000,
            )} detik.`,
          ),
        );
      }, timeoutMs);

      waiter.resolve = (value) => {
        clearTimeout(waiter.timeout);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(waiter.timeout);
        reject(error);
      };

      readyWaiters.add(waiter);
    });
  }

  function clearAutoRecoverTimer() {
    clearTimeout(autoRecoverTimer);
    autoRecoverTimer = null;
  }

  function scheduleAutoRecover(session, chatId) {
    if (!session || desiredSessionId !== session.id) {
      return;
    }

    clearAutoRecoverTimer();
    logger.warn("Scheduling WhatsApp session auto recovery", {
      sessionId: session.id,
      delayMs: AUTO_RECOVER_DELAY_MS,
    });
    autoRecoverTimer = setTimeout(() => {
      autoRecoverTimer = null;
      if (desiredSessionId !== session.id || isSessionRunning()) {
        logger.info("Skipping WhatsApp auto recovery", {
          sessionId: session.id,
          desiredSessionId,
          running: isSessionRunning(),
        });
        return;
      }

      startSession(session, chatId, {
        autoRecover: true,
        confirmedSwitch: true,
      }).catch((error) => {
        logger.error("WhatsApp session auto recovery failed", {
          sessionId: session.id,
          message: error.message,
        });
      });
    }, AUTO_RECOVER_DELAY_MS);
  }

  function getDisconnectStatusCode(lastDisconnect) {
    return (
      lastDisconnect?.error?.output?.statusCode ||
      lastDisconnect?.error?.output?.payload?.statusCode ||
      lastDisconnect?.error?.statusCode ||
      0
    );
  }

  const authFailureCounts = new Map();
  const sessionWasConnected = new Map();

  function isExpiredSessionDisconnect(session, lastDisconnect) {
    const code = getDisconnectStatusCode(lastDisconnect);
    const isAuthError =
      code === WA_LOGGED_OUT_STATUS_CODE ||
      code === WA_FORBIDDEN_STATUS_CODE;

    if (!isAuthError) {
      if (session?.id) {
        authFailureCounts.delete(session.id);
      }
      return false;
    }

    const wasConnected = Boolean(sessionWasConnected.get(session?.id));

    // Jika sesi sebelumnya sudah connected lalu terputus dan mendapat 401/403 pada reconnect pertama,
    // beri kesempatan 1x auto-recovery sebelum mematikan sesi permanen.
    if (wasConnected) {
      const currentFailures = (authFailureCounts.get(session?.id) || 0) + 1;
      if (session?.id) {
        authFailureCounts.set(session.id, currentFailures);
      }

      if (currentFailures <= 1 && desiredSessionId === session?.id) {
        logger.warn(
          "Transient WhatsApp auth failure detected on reconnect, attempting auto-recovery before logout",
          {
            sessionId: session?.id,
            statusCode: code,
            attempt: currentFailures,
          },
        );
        return false;
      }
    }

    return true;
  }

  async function handleLoggedOutSession(session, statusCode = 401) {
    clearAutoRecoverTimer();
    desiredSessionId = "";
    connectionState = "logged_out";
    controller = null;
    activeSession = await markWhatsAppSessionStatus(session.id, "logged_out");
    rejectSocketReady(new Error("WhatsApp session logged out."));

    // Simpan pending re-auth untuk semua subscriber saat ini
    const chatIds = Array.from(qrSubscribers);
    for (const chatId of chatIds) {
      pendingExpiredSessionReauth.set(String(chatId), {
        sessionId: session.id,
        expiresAt: Date.now() + PENDING_REAUTH_TTL_MS,
      });
    }

    logger.warn("WhatsApp session expired, asking subscribers for re-auth confirmation", {
      sessionId: session.id,
      statusCode,
      subscribers: chatIds.length,
    });

    const statusLabel = statusCode === WA_FORBIDDEN_STATUS_CODE
      ? "403 Forbidden (Kredensial ditolak server)"
      : "401 Logged Out (Perangkat di-unlink)";

    await notifySubscribers(
      [
        "⚠️ <b>WhatsApp Session Usang / Ditolak</b>",
        "",
        `Session: <b>${escapeTelegramHtml(session.label)}</b>`,
        `Phone: <code>${escapeTelegramHtml(session.phone)}</code>`,
        `Status: <code>${escapeTelegramHtml(statusLabel)}</code>`,
        "",
        "Sesi ini sudah tidak valid dan tidak bisa auto-recovery.",
        "",
        "Apakah Anda ingin <b>membersihkan credential lama</b> dan menampilkan <b>QR Code baru</b> untuk login ulang?",
        "",
        "Balas <code>YA</code> untuk bersihkan credential lama dan tampilkan QR Code baru.",
        "Balas <code>TIDAK</code> untuk batal.",
        "",
        "⏱️ Konfirmasi berlaku 5 menit.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  async function completePendingExpiredSessionReauth(chatId, answer) {
    const key = String(chatId);
    const pending = pendingExpiredSessionReauth.get(key);
    if (!pending) {
      return null;
    }

    const normalizedAnswer = String(answer || "").trim().toUpperCase();
    if (Date.now() > pending.expiresAt) {
      pendingExpiredSessionReauth.delete(key);
      return [
        "⌛ **Konfirmasi Re-Auth Expired**",
        "",
        "Jalankan ulang `/login <nomor_urut>` jika masih ingin login ulang.",
      ].join("\n");
    }

    if (![ "YA", "Y", "YES", "TIDAK", "N", "NO" ].includes(normalizedAnswer)) {
      return [
        "⚠️ **Menunggu konfirmasi re-auth session usang**",
        "",
        "Balas `YA` untuk bersihkan credential lama dan tampilkan QR baru.",
        "Balas `TIDAK` untuk membatalkan.",
      ].join("\n");
    }

    pendingExpiredSessionReauth.delete(key);

    if ([ "TIDAK", "N", "NO" ].includes(normalizedAnswer)) {
      return [
        "✅ **Re-Auth Dibatalkan**",
        "",
        "Session tetap dalam status tidak aktif.",
        "Jalankan `/login <nomor_urut>` kapan saja jika ingin login ulang.",
      ].join("\n");
    }

    // YA — hapus credential lama dan mulai fresh auth
    const session = await resolveWhatsAppSession(pending.sessionId);
    if (!session) {
      return [
        "❌ **Session Tidak Ditemukan**",
        "",
        "Session yang dimaksud tidak lagi terdaftar.",
        "Jalankan `/sessions` untuk melihat daftar session terbaru.",
      ].join("\n");
    }

    logger.info("Purging expired session auth dir for fresh re-auth", {
      sessionId: session.id,
      authDir: session.auth_dir,
    });

    try {
      await fs.rm(session.auth_dir, { recursive: true, force: true });
      logger.info("Expired session auth dir purged", { authDir: session.auth_dir });
    } catch (error) {
      logger.warn("Failed to purge expired session auth dir", {
        authDir: session.auth_dir,
        message: error.message,
      });
    }

    releaseProcessLockByDir(session.auth_dir);
    qrNotifyCount = 0;

    const startResult = await startSession(session, chatId, { confirmedSwitch: true });
    return [
      "🔄 **Membuat Sesi Baru**",
      "",
      `Session: **${session.label}**`,
      "",
      "Credential lama berhasil dihapus. Memulai autentikasi ulang...",
      "",
      startResult,
    ].join("\n");
  }

  function createPendingSessionSwitch(chatId, currentSession, nextSession) {
    const key = String(chatId);
    pendingSessionSwitches.set(key, {
      activeSessionId: currentSession.id,
      requestedSessionId: nextSession.id,
      expiresAt: Date.now() + PENDING_SESSION_SWITCH_TTL_MS,
    });

    return [
      "⚠️ **Session WhatsApp sedang aktif**",
      "",
      "📱 **Session aktif:**",
      `1. **${currentSession.label}**`,
      `   Phone: \`${currentSession.phone}\``,
      "",
      "🔄 **Session yang diminta:**",
      `**${nextSession.label}**`,
      `Phone: \`${nextSession.phone}\``,
      "",
      "Apakah ingin mengganti session?",
      "",
      "Balas `YA` untuk stop session aktif dan menjalankan session baru.",
      "Balas `TIDAK` untuk batal.",
      "",
      "⏱️ Konfirmasi berlaku 2 menit.",
    ].join("\n");
  }

  async function stopCurrentSessionForSwitch(reason) {
    if (!controller?.getStatus?.().running || !activeSession) {
      return null;
    }

    const stoppedSession = activeSession;
    logger.info("Stopping active WhatsApp session before confirmed switch", {
      sessionId: stoppedSession.id,
      reason,
    });
    await controller.stop(reason);
    controller = null;
    connectionState = "stopped";
    await markWhatsAppSessionStatus(stoppedSession.id, "stopped");
    return stoppedSession;
  }

  async function startSession(session, chatId, options = {}) {
    if (chatId) {
      qrSubscribers.add(String(chatId));
    }

    if (isSessionRunning()) {
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

      if (!options.confirmedSwitch) {
        logger.info("WhatsApp session switch requires confirmation", {
          activeSessionId: activeSession?.id,
          nextSessionId: session.id,
          chatId,
        });
        return createPendingSessionSwitch(chatId, activeSession, session);
      }

      logger.info("Stopping active session before confirmed switch", {
        activeSessionId: activeSession?.id,
        nextSessionId: session.id,
      });
      await stopCurrentSessionForSwitch("Confirmed WhatsApp session switch");
    }

    clearAutoRecoverTimer();
    qrNotifyCount = 0;
    desiredSessionId = session.id;
    connectionState = options.autoRecover ? "reconnecting" : "starting";
    activeSession = await markWhatsAppSessionStatus(session.id, "starting");
    controller = await startWhatsAppBot({
      authDir: session.auth_dir,
      onQr: notifyQr,
      onControllerUpdate: (nextController) => {
        if (desiredSessionId === session.id) {
          logger.info("WhatsApp session controller updated", {
            sessionId: session.id,
          });
          controller = nextController;
        }
      },
      onConnectionUpdate: async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          qrNotifyCount = 0;
          if (session?.id) {
            authFailureCounts.delete(session.id);
            sessionWasConnected.set(session.id, true);
          }
          connectionState = "connected";
          await markWhatsAppSessionStatus(session.id, "connected");
          resolveSocketReady();
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
          const statusCode = getDisconnectStatusCode(lastDisconnect);
          if (isExpiredSessionDisconnect(session, lastDisconnect)) {
            logger.warn("WhatsApp session credential expired or rejected, asking for re-auth", {
              sessionId: session.id,
              statusCode,
            });
            await handleLoggedOutSession(session, statusCode);
            return;
          }

          connectionState = "closed";
          controller = null;
          await markWhatsAppSessionStatus(session.id, "stopped");
          rejectSocketReady(new Error("WhatsApp connection closed."));
          if (desiredSessionId === session.id) {
            scheduleAutoRecover(session, chatId);
            return;
          }
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

  async function completePendingSessionSwitch(chatId, answer) {
    const key = String(chatId);
    const pending = pendingSessionSwitches.get(key);
    if (!pending) {
      return null;
    }

    const normalizedAnswer = String(answer || "").trim().toUpperCase();
    if (Date.now() > pending.expiresAt) {
      pendingSessionSwitches.delete(key);
      return [
        "⌛ **Konfirmasi Switch Session Expired**",
        "",
        "Jalankan ulang `/login <nomor_urut>` jika masih ingin mengganti session.",
      ].join("\n");
    }

    if (!["YA", "Y", "YES", "TIDAK", "N", "NO"].includes(normalizedAnswer)) {
      return [
        "⚠️ **Menunggu konfirmasi switch session**",
        "",
        "Balas `YA` untuk mengganti session.",
        "Balas `TIDAK` untuk membatalkan.",
      ].join("\n");
    }

    if (["TIDAK", "N", "NO"].includes(normalizedAnswer)) {
      pendingSessionSwitches.delete(key);
      return [
        "✅ **Switch Session Dibatalkan**",
        "",
        "Session WhatsApp yang sedang aktif tetap berjalan.",
      ].join("\n");
    }

    pendingSessionSwitches.delete(key);
    const nextSession = await resolveWhatsAppSession(pending.requestedSessionId);
    if (!nextSession) {
      return [
        "❌ **Gagal Mengganti Session**",
        "",
        "Session tujuan tidak ditemukan lagi.",
        "Jalankan `/sessions` untuk melihat daftar session terbaru.",
      ].join("\n");
    }

    try {
      const stoppedSession = await stopCurrentSessionForSwitch(
        "Telegram confirmed session switch",
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      releaseProcessLockByDir(nextSession.auth_dir);

      let startResult;
      try {
        startResult = await startSession(nextSession, chatId, {
          confirmedSwitch: true,
        });
      } catch (startError) {
        logger.warn("Initial session start failed during switch, retrying with forced lock cleanup", {
          sessionId: nextSession.id,
          authDir: nextSession.auth_dir,
          error: startError.message,
        });
        releaseProcessLockByDir(nextSession.auth_dir);
        startResult = await startSession(nextSession, chatId, {
          confirmedSwitch: true,
        });
      }

      return [
        "✅ **Switch Session Diproses**",
        "",
        stoppedSession
          ? `Session lama dimatikan: **${stoppedSession.label}**`
          : "Tidak ada session aktif yang perlu dimatikan.",
        `Session baru: **${nextSession.label}**`,
        "",
        startResult,
      ].join("\n");
    } catch (error) {
      logger.error("Failed to switch WhatsApp session after confirmation", {
        message: error.message,
        activeSessionId: pending.activeSessionId,
        requestedSessionId: pending.requestedSessionId,
      });
      return [
        "❌ **Gagal Mengganti Session**",
        "",
        "Session lama belum berhasil dimatikan atau session baru gagal dijalankan.",
        "",
        `Detail: \`${escapeTelegramHtml(error.message)}\``,
        "",
        "Coba jalankan `/stop 1`, lalu ulangi `/login <nomor_urut>`.",
      ].join("\n");
    }
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

    desiredSessionId = "";
    clearAutoRecoverTimer();
    await controller.stop("Telegram /stop");
    controller = null;
    connectionState = "stopped";
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

    desiredSessionId = "";
    clearAutoRecoverTimer();
    await controller.logout("Telegram /logout");
    controller = null;
    connectionState = "logged_out";
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
      desiredSessionId = "";
      clearAutoRecoverTimer();
      await controller.stop("Delete active WhatsApp session");
      controller = null;
      connectionState = "stopped";
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
      running: isSessionRunning(),
      active_session: activeSession,
      connection_state: connectionState,
      desired_session_id: desiredSessionId,
      qr_subscribers: qrSubscribers.size,
    };
  }

  function getSocket() {
    return isSessionRunning() && connectionState === "connected"
      ? controller?.sock || null
      : null;
  }

  async function ensureReady(chatId, options = {}) {
    const timeoutMs = options.timeoutMs || DEFAULT_READY_TIMEOUT_MS;
    const forceRecover = Boolean(options.forceRecover);
    if (chatId) {
      qrSubscribers.add(String(chatId));
    }

    if (!forceRecover && isSessionRunning() && connectionState === "connected") {
      return getSocket();
    }

    const registry = await getWhatsAppSessionRegistry();
    const session =
      activeSession ||
      (desiredSessionId
        ? await resolveWhatsAppSession(desiredSessionId)
        : registry.active_session_id
          ? await resolveWhatsAppSession(registry.active_session_id)
          : null);

    if (!session) {
      throw new Error("WhatsApp session belum aktif. Jalankan /login dulu.");
    }

    logger.warn("Ensuring WhatsApp session is ready", {
      sessionId: session.id,
      running: isSessionRunning(),
      connectionState,
      desiredSessionId,
      forceRecover,
    });

    if (forceRecover && controller?.getStatus?.().running) {
      logger.warn("Forcing WhatsApp session recovery", {
        sessionId: session.id,
      });
      await controller.stop("Force recover WhatsApp session");
      controller = null;
      connectionState = "closed";
    }

    if (!isSessionRunning()) {
      await startSession(session, chatId, {
        autoRecover: connectionState === "closed",
        confirmedSwitch: true,
      });
    }

    await waitForConnection(timeoutMs);
    const socket = getSocket();
    if (!socket?.sendMessage) {
      throw new Error("WhatsApp session belum ready untuk mengirim pesan.");
    }
    return socket;
  }

  async function cancelQr(chatId) {
    const key = chatId ? String(chatId) : null;

    // Clear any pending re-auth confirmation or switch for this user
    if (key) {
      pendingExpiredSessionReauth.delete(key);
      pendingSessionSwitches.delete(key);
      pendingLoginNames.delete(key);
    }

    // Jika sesi sudah terhubung atau tidak sedang menunggu scan QR, jangan hentikan sesi yang sudah login!
    if (connectionState === "connected" || qrNotifyCount === 0 || !controller?.getStatus?.().running) {
      return [
        "ℹ️ **Tidak Ada Sesi QR Aktif**",
        "",
        "Tidak ada proses scan QR yang sedang berjalan saat ini.",
      ].join("\n");
    }

    const stoppedSession = activeSession;
    desiredSessionId = "";
    clearAutoRecoverTimer();
    qrNotifyCount = 0;
    await controller.stop("Telegram /cancel QR");
    controller = null;
    connectionState = "stopped";
    if (stoppedSession) {
      await markWhatsAppSessionStatus(stoppedSession.id, "stopped");
    }

    logger.info("WhatsApp QR session cancelled by user", {
      chatId: key,
      sessionId: stoppedSession?.id,
    });

    return [
      "🛑 **Sesi Scan QR Dibatalkan**",
      "",
      stoppedSession
        ? `Session: **${stoppedSession.label}**`
        : "",
      "",
      "Proses login QR dihentikan.",
      "Gunakan `/login <nomor_urut>` untuk memulai kembali kapan saja.",
    ].filter(Boolean).join("\n");
  }

  return {
    cancelQr,
    completePendingExpiredSessionReauth,
    completePendingLoginName,
    completePendingSessionSwitch,
    deleteSession,
    ensureReady,
    getSocket,
    getStatus,
    listSessions,
    login,
    logout,
    startSavedSession,
    stop,
  };
}
