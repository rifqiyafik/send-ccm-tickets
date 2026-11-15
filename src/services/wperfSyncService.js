import fs from "node:fs/promises";
import path from "node:path";

import { queryDatabase } from "./databaseService.js";
import { createLogger } from "../utils/logger.js";
import { getWibDateString } from "../utils/dateTime.js";
import { createTelegramRichMessage } from "../utils/telegramFormat.js";

const logger = createLogger("wperfSyncService");

const DEFAULT_SQL_PATH = path.join(process.cwd(), "scripts", "wperf_mv_update.sql");
const DEFAULT_STATE_PATH = path.join(
  process.cwd(),
  "data",
  "runtime",
  "wperf_sync_state.json",
);

// memformat progress bar teks dengan karakter blok Unicode
export function formatProgressBar(percent, length = 10) {
  const bounded = Math.min(100, Math.max(0, Number(percent) || 0));
  const filled = Math.min(length, Math.max(0, Math.floor((bounded / 100) * length)));
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

// mem-parse file SQL menjadi daftar statement terpisah yang siap dieksekusi
export async function loadWperfStatements(filePath = DEFAULT_SQL_PATH) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// memformat pesan tampilan progres sinkronisasi WPERF untuk Telegram
export function formatWperfProgressMessage({
  stage = 0,
  percent = 0,
  isDone = false,
  error = null,
  durationSec = 0,
  rowCounts = {},
} = {}) {
  if (error) {
    return [
      "❌ **Pembaruan WPERF Gagal**",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `🛑 **Error:** \`${error.message || error}\``,
      `⏱️ **Durasi Sebelum Gagal:** ${durationSec}s`,
      "",
      "👉 Periksa koneksi PostgreSQL atau ketersediaan materialized view.",
    ].join("\n");
  }

  if (isDone) {
    const wibTimeString = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "medium",
    });

    return [
      "✅ **Pembaruan Data WPERF Berhasil**",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `⏱️ **Total Durasi:** ${durationSec} detik`,
      `📅 **Waktu Selesai:** ${wibTimeString} WIB`,
      "",
      "🔄 **Materialized Views:** 4/4 Refresh Selesai",
      "📥 **Tabel Leapdate (UPSERT):**",
      `  • Region    : ${rowCounts.region != null ? `${rowCounts.region} baris` : "Selesai"}`,
      `  • NOP       : ${rowCounts.nop != null ? `${rowCounts.nop} baris` : "Selesai"}`,
      `  • Kabupaten : ${rowCounts.kabupaten != null ? `${rowCounts.kabupaten} baris` : "Selesai"}`,
      `  • Kecamatan : ${rowCounts.kecamatan != null ? `${rowCounts.kecamatan} baris` : "Selesai"}`,
      "",
      "✨ Seluruh level agregasi berhasil disinkronkan ke PostgreSQL.",
    ].join("\n");
  }

  const bar = formatProgressBar(percent);
  const getStatus = (targetStage) => {
    if (stage > targetStage) return "✅ Selesai";
    if (stage === targetStage) return "⏳ Memproses...";
    return "⏳ Menunggu";
  };

  return [
    "📊 **Pembaruan Data WPERF**",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `📈 **Progress:** \`[${bar}] ${percent}%\``,
    `⏱️ **Durasi Berjalan:** ${durationSec} detik`,
    "",
    `🔄 **1. Refresh Materialized Views (4 MV):** ${getStatus(0)}`,
    "",
    "📥 **2. Update Tabel Leapdate:**",
    `  • Region    : ${getStatus(1)} ${rowCounts.region != null ? `(${rowCounts.region} baris)` : ""}`,
    `  • NOP       : ${getStatus(2)} ${rowCounts.nop != null ? `(${rowCounts.nop} baris)` : ""}`,
    `  • Kabupaten : ${getStatus(3)} ${rowCounts.kabupaten != null ? `(${rowCounts.kabupaten} baris)` : ""}`,
    `  • Kecamatan : ${getStatus(4)} ${rowCounts.kecamatan != null ? `(${rowCounts.kecamatan} baris)` : ""}`,
  ].join("\n");
}

let activeSyncPromise = null;

// menjalankan proses sinkronisasi SQL bertahap (Refresh MV -> Region -> NOP -> Kabupaten -> Kecamatan)
export async function executeWperfSync({
  sqlFilePath = DEFAULT_SQL_PATH,
  queryFn = queryDatabase,
  onProgress = null,
} = {}) {
  if (activeSyncPromise) {
    throw new Error("Pembaruan WPERF sedang berjalan di latar belakang. Mohon tunggu hingga selesai.");
  }

  const startTime = Date.now();
  const getDurationSec = () => Math.round((Date.now() - startTime) / 1000);

  const rowCounts = {
    region: null,
    nop: null,
    kabupaten: null,
    kecamatan: null,
  };

  const notify = async (stage, percent, isDone = false, error = null) => {
    if (typeof onProgress === "function") {
      try {
        await onProgress({
          stage,
          percent,
          isDone,
          error,
          durationSec: getDurationSec(),
          rowCounts,
        });
      } catch (cbErr) {
        logger.debug("onProgress callback error ignored", { error: cbErr.message });
      }
    }
  };

  activeSyncPromise = (async () => {
    try {
      const statements = await loadWperfStatements(sqlFilePath);
      if (statements.length < 5) {
        throw new Error(
          `Format SQL tidak sesuai: diharapkan minimal 5 statement (4 refresh MV + level queries), ditemukan ${statements.length}`,
        );
      }

      let currentStage = 0;
      let currentStep = "Step 0 - Refreshing Materialized Views";

      // TAHAP 0: Refresh 4 Materialized Views
      logger.info("WPERF sync: Step 0 - Refreshing Materialized Views");
      await notify(0, 0);

      // Statement 0 s.d 3 adalah REFRESH MATERIALIZED VIEW
      const refreshStatements = statements.slice(0, 4);
      for (const refreshSql of refreshStatements) {
        await queryFn(refreshSql);
      }

      // TAHAP 1: Region Level (25%)
      currentStage = 1;
      currentStep = "Step 1 - Updating Region level";
      logger.info("WPERF sync: Step 1 - Updating Region level");
      await notify(1, 0);
      const regionRes = await queryFn(statements[4]);
      rowCounts.region = regionRes?.rowCount ?? 0;
      await notify(1, 25);

      // TAHAP 2: NOP Level (50%)
      currentStage = 2;
      currentStep = "Step 2 - Updating NOP level";
      logger.info("WPERF sync: Step 2 - Updating NOP level");
      await notify(2, 25);
      const nopRes = await queryFn(statements[5]);
      rowCounts.nop = nopRes?.rowCount ?? 0;
      await notify(2, 50);

      // TAHAP 3: Kabupaten Level (75%)
      currentStage = 3;
      currentStep = "Step 3 - Updating Kabupaten level";
      logger.info("WPERF sync: Step 3 - Updating Kabupaten level");
      await notify(3, 50);
      const kabRes = await queryFn(statements[6]);
      rowCounts.kabupaten = kabRes?.rowCount ?? 0;
      await notify(3, 75);

      // TAHAP 4: Kecamatan Level (100%)
      currentStage = 4;
      currentStep = "Step 4 - Updating Kecamatan level";
      logger.info("WPERF sync: Step 4 - Updating Kecamatan level");
      await notify(4, 75);
      const kecRes = await queryFn(statements[7]);
      rowCounts.kecamatan = kecRes?.rowCount ?? 0;

      // Selesai
      await notify(4, 100, true, null);

      logger.info("WPERF sync completed successfully", {
        durationSec: getDurationSec(),
        rowCounts,
      });

      return {
        success: true,
        durationSec: getDurationSec(),
        rowCounts,
      };
    } catch (error) {
      logger.error("WPERF sync failed", {
        stage: currentStage,
        step: currentStep,
        message: error.message,
        durationSec: getDurationSec(),
      });
      await notify(currentStage, 0, false, error);
      throw error;
    } finally {
      activeSyncPromise = null;
    }
  })();

  return activeSyncPromise;
}

// membaca state waktu sinkronisasi terakhir untuk scheduler
async function loadSyncState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastRunDate: null, lastRunAt: null };
  }
}

// menyimpan state waktu sinkronisasi terakhir
async function saveSyncState(state, statePath) {
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    logger.warn("Failed to persist wperf sync state", {
      error: error.message,
      statePath,
    });
  }
}

// factory service untuk WPERF Sync dengan scheduler harian (09:00 WIB) dan trigger command
export function createWperfSyncService({
  telegramBot,
  adminChatIds = [],
  sqlFilePath = DEFAULT_SQL_PATH,
  statePath = DEFAULT_STATE_PATH,
  queryFn = queryDatabase,
  scheduledHour = Number(process.env.WPERF_SCHEDULED_HOUR ?? 9),
  scheduledMinute = Number(process.env.WPERF_SCHEDULED_MINUTE ?? 0),
  checkIntervalMs = 60000,
} = {}) {
  let timer = null;
  let isRunning = false;
  let inMemoryState = { lastRunDate: null, lastRunAt: null };

  let statePromise = loadSyncState(statePath)
    .then((loaded) => {
      inMemoryState = {
        lastRunDate: inMemoryState.lastRunDate || loaded.lastRunDate || null,
        lastRunAt: inMemoryState.lastRunAt || loaded.lastRunAt || null,
      };
    })
    .catch(() => {});

  async function ensureStateLoaded() {
    if (statePromise) {
      await statePromise;
      statePromise = null;
    }
  }

  // helper untuk mengirim/mengedit pesan progres ke satu atau lebih chat admin
  async function runWithTelegramReporter({
    targetChatIds = [],
    initialMessage = "⏳ **Memulai sinkronisasi WPERF...**",
  } = {}) {
    const messageTracker = new Map();

    // kirim pesan awal ke target admin
    for (const chatId of targetChatIds) {
      try {
        const rich = createTelegramRichMessage(initialMessage);
        const res = await telegramBot.sendMessage(chatId, rich.text, rich.options);
        const msgId = res?.message_id;
        if (msgId) {
          messageTracker.set(String(chatId), msgId);
        }
      } catch (sendErr) {
        logger.warn("Failed to send initial WPERF status message", {
          chatId,
          error: sendErr.message,
        });
      }
    }

    const onProgress = async (progressState) => {
      const text = formatWperfProgressMessage(progressState);
      const rich = createTelegramRichMessage(text);

      for (const [chatId, msgId] of messageTracker.entries()) {
        try {
          if (typeof telegramBot.editMessageText === "function") {
            await telegramBot.editMessageText(chatId, msgId, rich.text, rich.options);
          } else {
            await telegramBot.sendMessage(chatId, rich.text, rich.options);
          }
        } catch (editErr) {
          logger.debug("Failed to edit WPERF progress message in Telegram", {
            chatId,
            msgId,
            error: editErr.message,
          });
        }
      }
    };

    return executeWperfSync({
      sqlFilePath,
      queryFn,
      onProgress,
    });
  }

  // eksekusi manual via command Telegram oleh admin
  async function executeManualSync(adminChatId) {
    const targetChatIds = [adminChatId].filter(Boolean);
    return runWithTelegramReporter({
      targetChatIds,
      initialMessage: "⏳ **Mempersiapkan pembaruan data WPERF...**",
    });
  }

  // cek waktu setiap interval untuk scheduler otomatis jam 09:00 WIB
  async function checkAndRunScheduled(now = new Date()) {
    await ensureStateLoaded();

    const wib = new Date(now.getTime() + 7 * 3600000);
    const todayWibDate = getWibDateString(now);
    const currentWibHour = wib.getUTCHours();
    const currentWibMinute = wib.getUTCMinutes();

    if (inMemoryState.lastRunDate === todayWibDate) {
      return false;
    }

    if (
      currentWibHour < scheduledHour ||
      (currentWibHour === scheduledHour && currentWibMinute < scheduledMinute)
    ) {
      return false;
    }

    logger.info("WPERF scheduled trigger activated at 09:00 WIB", {
      todayWibDate,
      currentWibHour,
      currentWibMinute,
      adminCount: adminChatIds.length,
    });

    // Tandai hari ini agar tidak jalan ganda
    inMemoryState = {
      lastRunDate: todayWibDate,
      lastRunAt: now.toISOString(),
    };
    await saveSyncState(inMemoryState, statePath);

    try {
      await runWithTelegramReporter({
        targetChatIds: adminChatIds,
        initialMessage: "⏰ **[AUTO-SCHEDULE] Memulai Pembaruan Data WPERF (09:00 WIB)...**",
      });
      return true;
    } catch (err) {
      logger.error("Scheduled WPERF sync failed", { error: err.message });
      return false;
    }
  }

  function start() {
    if (isRunning) return;
    isRunning = true;
    logger.info("WPERF sync scheduler started", {
      scheduledHour,
      scheduledMinute,
      checkIntervalMs,
    });

    checkAndRunScheduled().catch(() => {});

    timer = setInterval(() => {
      checkAndRunScheduled().catch((err) => {
        logger.error("Error in WPERF scheduler check", { error: err.message });
      });
    }, checkIntervalMs);

    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  function stop() {
    if (!isRunning) return;
    isRunning = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logger.info("WPERF sync scheduler stopped");
  }

  return {
    start,
    stop,
    executeManualSync,
    checkAndRunScheduled,
    isSyncRunning: () => Boolean(activeSyncPromise),
  };
}
