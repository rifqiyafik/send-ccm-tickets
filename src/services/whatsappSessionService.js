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
const DEFAULT_READY_TIMEOUT_MS = Number(
  process.env.WA_READY_TIMEOUT_MS || 30000,
);
const AUTO_RECOVER_DELAY_MS = Number(
  process.env.WA_AUTO_RECOVER_DELAY_MS || 7000,
);
const WA_LOGGED_OUT_STATUS_CODE = 401;

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
  startWhatsAppBot = startBot,
}) {
  let controller = null;
  let activeSession = null;
  let desiredSessionId = "";
  let connectionState = "stopped";
  let autoRecoverTimer = null;
  const qrSubscribers = new Set();
  const pendingLoginNames = new Map();
  const pendingSessionSwitches = new Map();
  const readyWaiters = new Set();

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

  function isLoggedOutDisconnect(lastDisconnect) {
    return getDisconnectStatusCode(lastDisconnect) === WA_LOGGED_OUT_STATUS_CODE;
  }

  async function handleLoggedOutSession(session) {
    clearAutoRecoverTimer();
    desiredSessionId = "";
    connectionState = "logged_out";
    controller = null;
    activeSession = await markWhatsAppSessionStatus(session.id, "logged_out");
    rejectSocketReady(new Error("WhatsApp session logged out."));

    await notifySubscribers(
      [
        "🚪 <b>WhatsApp Session Logged Out</b>",
        "",
        `Session: <b>${escapeTelegramHtml(session.label)}</b>`,
        `Phone: <code>${escapeTelegramHtml(session.phone)}</code>`,
        "",
        "Credential lokal session ini sudah tidak valid, jadi bot tidak bisa auto-recovery dan QR tidak akan muncul dari credential lama.",
        "",
        "Langkah perbaikan:",
        "1. Jalankan <code>/delete_session 1</code> untuk hapus credential lokal.",
        `2. Jalankan <code>/login ${escapeTelegramHtml(session.phone)}</code> untuk membuat session baru.`,
        "3. Isi nama session, lalu scan QR yang dikirim bot.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
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
          if (isLoggedOutDisconnect(lastDisconnect)) {
            logger.warn("WhatsApp session logged out, auto recovery disabled", {
              sessionId: session.id,
              statusCode: getDisconnectStatusCode(lastDisconnect),
            });
            await handleLoggedOutSession(session);
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

  return {
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
