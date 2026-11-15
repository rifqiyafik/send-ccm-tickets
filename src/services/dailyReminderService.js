import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";
import { createTelegramRichMessage } from "../utils/telegramFormat.js";
import { formatDailyInjectReminderMessage } from "./messageTemplateService.js";
import {
  listAuthorizedTelegramChats,
  getTelegramTargetGroups,
} from "./telegramAccessService.js";
import { getWibDateString } from "./ticketPollingService.js";

const logger = createLogger("dailyReminderService");

const DEFAULT_STATE_PATH = path.join(
  process.cwd(),
  "data",
  "runtime",
  "daily_reminder_state.json",
);

// membaca state kapan terakhir reminder dikirim agar tidak terjadi pengiriman duplikat
async function loadReminderState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastSentDate: parsed.lastSentDate || null,
      lastSentAt: parsed.lastSentAt || null,
    };
  } catch {
    return {
      lastSentDate: null,
      lastSentAt: null,
    };
  }
}

// menyimpan state pengiriman reminder harian
async function saveReminderState(state, statePath) {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    logger.warn("Failed to persist daily reminder state", {
      error: error.message,
      statePath,
    });
  }
}

// mengumpulkan daftar Chat ID Telegram grup yang akan menerima reminder sore hari
export async function resolveDailyReminderChatIds({
  adminChatIds = [],
  getTargetChatIds,
} = {}) {
  if (typeof getTargetChatIds === "function") {
    try {
      const ids = await getTargetChatIds();
      if (Array.isArray(ids) && ids.length > 0) {
        return Array.from(new Set(ids.map(String).filter(Boolean)));
      }
    } catch (err) {
      logger.warn("Custom getTargetChatIds failed in dailyReminderService", {
        error: err.message,
      });
    }
  }

  // Cek env override jika didefinisikan
  const envChatIds = String(process.env.TELEGRAM_DAILY_REMINDER_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envChatIds.length > 0) {
    return Array.from(new Set(envChatIds));
  }

  const targets = new Set();

  try {
    // 1. Ambil grup berizin dari authorized_groups di config/telegram.json
    const { groups } = await listAuthorizedTelegramChats();
    for (const group of groups || []) {
      if (group?.id) {
        targets.add(String(group.id).trim());
      }
    }
  } catch (err) {
    logger.debug("Failed to load authorized groups for daily reminder", {
      error: err.message,
    });
  }

  try {
    // 2. Ambil grup target SQA dari target_groups di config/telegram.json
    const targetGroups = await getTelegramTargetGroups();
    const sqaGroup = targetGroups["SQA"] || targetGroups["MAIN SQA"];
    if (sqaGroup?.id) {
      targets.add(String(sqaGroup.id).trim());
    }
  } catch (err) {
    logger.debug("Failed to load SQA target group for daily reminder", {
      error: err.message,
    });
  }

  // Fallback ke admin chat IDs jika tidak ada grup yang ditemukan
  if (targets.size === 0 && Array.isArray(adminChatIds)) {
    for (const adminId of adminChatIds) {
      if (adminId) targets.add(String(adminId).trim());
    }
  }

  return Array.from(targets);
}

// factory service pengingat harian penutupan report jam 17:00 WIB
export function createDailyReminderService({
  telegramBot,
  adminChatIds = [],
  statePath = DEFAULT_STATE_PATH,
  getTargetChatIds,
  targetHour = Number(process.env.DAILY_REMINDER_HOUR ?? 17),
  targetMinute = Number(process.env.DAILY_REMINDER_MINUTE ?? 0),
  checkIntervalMs = 30000,
} = {}) {
  let timer = null;
  let isRunning = false;
  let inMemoryState = {
    lastSentDate: null,
    lastSentAt: null,
  };

  let stateLoadedPromise = loadReminderState(statePath)
    .then((loaded) => {
      inMemoryState = {
        lastSentDate: inMemoryState.lastSentDate || loaded.lastSentDate || null,
        lastSentAt: inMemoryState.lastSentAt || loaded.lastSentAt || null,
      };
    })
    .catch(() => {});

  async function ensureStateLoaded() {
    if (stateLoadedPromise) {
      await stateLoadedPromise;
      stateLoadedPromise = null;
    }
  }

  // memeriksa waktu dan mengirim reminder jika sudah jam target (17:00 WIB) & belum dikirim hari ini
  async function checkAndSendReminder(now = new Date()) {
    await ensureStateLoaded();

    const wib = new Date(now.getTime() + 7 * 3600000);
    const todayWibDate = getWibDateString(now);
    const currentWibHour = wib.getUTCHours();
    const currentWibMinute = wib.getUTCMinutes();

    // Pastikan tidak dikirim berulang di hari yang sama
    if (inMemoryState.lastSentDate === todayWibDate) {
      return { sent: false, reason: "ALREADY_SENT_TODAY", date: todayWibDate };
    }

    // Periksa apakah waktu saat ini sudah mencapai atau melewati jam 17:00 WIB (dalam rentang jam 17)
    const isTimeToRemind =
      currentWibHour === targetHour && currentWibMinute >= targetMinute;

    if (!isTimeToRemind) {
      return {
        sent: false,
        reason: "NOT_TIME_YET",
        currentTime: `${currentWibHour}:${String(currentWibMinute).padStart(2, "0")} WIB`,
      };
    }

    logger.info("Triggering 17:00 WIB daily inject reminder", {
      todayWibDate,
      time: `${currentWibHour}:${currentWibMinute} WIB`,
    });

    return await dispatchReminder(todayWibDate);
  }

  // mengirimkan pesan reminder ke seluruh target chat ID
  async function dispatchReminder(recordDate = getWibDateString(), specificChatIds = null) {
    await ensureStateLoaded();

    if (!telegramBot?.sendMessage) {
      logger.warn("Telegram bot sendMessage not available, cannot send reminder");
      return { sent: false, reason: "BOT_NOT_AVAILABLE" };
    }

    const recipientChatIds = specificChatIds
      ? Array.from(new Set(specificChatIds.map(String).filter(Boolean)))
      : await resolveDailyReminderChatIds({ adminChatIds, getTargetChatIds });

    if (recipientChatIds.length === 0) {
      logger.warn("No recipient chat IDs found for daily reminder");
      return { sent: false, reason: "NO_RECIPIENTS" };
    }

    const messageText = formatDailyInjectReminderMessage();
    const richMessage = createTelegramRichMessage(messageText);

    const sentTo = [];
    const failedTo = [];

    for (const chatId of recipientChatIds) {
      try {
        await telegramBot.sendMessage(
          chatId,
          richMessage.text,
          richMessage.options,
        );
        sentTo.push(chatId);
      } catch (err) {
        logger.warn("Failed to send daily reminder to chat", {
          chatId,
          error: err.message,
        });
        failedTo.push(chatId);
      }
    }

    // Perbarui state hanya jika ada yang berhasil terkirim
    if (sentTo.length > 0) {
      inMemoryState.lastSentDate = recordDate;
      inMemoryState.lastSentAt = new Date().toISOString();
      await saveReminderState(inMemoryState, statePath);

      logger.info("Daily inject reminder sent successfully", {
        recordDate,
        sentCount: sentTo.length,
        recipients: sentTo,
      });
    }

    return {
      sent: sentTo.length > 0,
      sentTo,
      failedTo,
      date: recordDate,
    };
  }

  // trigger manual untuk pengujian atau perintah admin
  async function triggerManual(targetChatId = null) {
    const targets = targetChatId ? [targetChatId] : null;
    return await dispatchReminder(getWibDateString(), targets);
  }

  function start() {
    if (timer) clearInterval(timer);
    isRunning = true;

    logger.info("Daily inject reminder service started", {
      targetTime: `${targetHour}:${String(targetMinute).padStart(2, "0")} WIB`,
    });

    // Cek satu kali beberapa detik setelah startup
    setTimeout(() => {
      checkAndSendReminder().catch(() => {});
    }, 4000);

    timer = setInterval(() => {
      checkAndSendReminder().catch((err) => {
        logger.error("Error in daily reminder check loop", err);
      });
    }, checkIntervalMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isRunning = false;
    logger.info("Daily inject reminder service stopped");
  }

  async function getStatus() {
    const today = getWibDateString();
    return {
      isRunning,
      targetTime: `${targetHour}:${String(targetMinute).padStart(2, "0")} WIB`,
      lastSentDate: inMemoryState.lastSentDate,
      isSentToday: inMemoryState.lastSentDate === today,
      todayWibDate: today,
    };
  }

  return {
    start,
    stop,
    checkAndSendReminder,
    dispatchReminder,
    triggerManual,
    getStatus,
  };
}
