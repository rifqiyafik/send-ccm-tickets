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
  mvDetails = {},
} = {}) {
  const durationFormatted = `${durationSec} detik${
    durationSec >= 60
      ? ` (${Math.floor(durationSec / 60)}m ${durationSec % 60}s)`
      : ""
  }`;

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

    const formatMvDone = (key, label) => {
      const dur = mvDetails?.[key]?.durationSec;
      return `  • ${label.padEnd(10)}: ✅ Selesai${dur != null ? ` (${dur}s)` : ""}`;
    };

    return [
      "✅ **Pembaruan Data WPERF Berhasil**",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `⏱️ **Total Durasi:** ${durationFormatted}`,
      `📅 **Waktu Selesai:** ${wibTimeString} WIB`,
      "",
      "🔄 **Materialized Views (4/4 Selesai):**",
      formatMvDone("region", "Region"),
      formatMvDone("nop", "NOP"),
      formatMvDone("kabupaten", "Kabupaten"),
      formatMvDone("kecamatan", "Kecamatan"),
      "",
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

  // Status untuk masing-masing Materialized View
  const getMvStatus = (key) => {
    const info = mvDetails?.[key];
    if (info?.status === "done") {
      const dur = info.durationSec != null ? ` (${info.durationSec}s)` : "";
      return `✅ Selesai${dur}`;
    }
    if (info?.status === "processing") {
      return "⏳ Memproses...";
    }
    // Jika tidak ada info di mvDetails, fallback berdasarkan stage
    if (stage > 0) return "✅ Selesai";
    return "⏳ Menunggu";
  };

  // Status untuk tabel Leapdate
  const getLeapStatus = (targetStage, count) => {
    if (stage > targetStage || count != null) {
      return `✅ Selesai ${count != null ? `(${count} baris)` : ""}`;
    }
    if (stage === targetStage) return "⏳ Memproses...";
    return "⏳ Menunggu";
  };

  return [
    "📊 **Pembaruan Data WPERF**",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `📈 **Progress:** \`[${bar}] ${percent}%\``,
    `⏱️ **Durasi Berjalan:** ${durationFormatted}`,
    "",
    "🔄 **1. Refresh Materialized Views (4 MV):**",
    `  • Region    : ${getMvStatus("region")}`,
    `  • NOP       : ${getMvStatus("nop")}`,
    `  • Kabupaten : ${getMvStatus("kabupaten")}`,
    `  • Kecamatan : ${getMvStatus("kecamatan")}`,
    "",
    "📥 **2. Update Tabel Leapdate:**",
    `  • Region    : ${getLeapStatus(1, rowCounts.region)}`,
    `  • NOP       : ${getLeapStatus(2, rowCounts.nop)}`,
    `  • Kabupaten : ${getLeapStatus(3, rowCounts.kabupaten)}`,
    `  • Kecamatan : ${getLeapStatus(4, rowCounts.kecamatan)}`,
  ].join("\n");
}

let activeSyncPromise = null;

// menjalankan proses sinkronisasi SQL bertahap (Refresh MV 1..4 -> Region -> NOP -> Kabupaten -> Kecamatan)
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

  const mvDetails = {
    region: { status: "pending", durationSec: null },
    nop: { status: "pending", durationSec: null },
    kabupaten: { status: "pending", durationSec: null },
    kecamatan: { status: "pending", durationSec: null },
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
          mvDetails,
        });
      } catch (cbErr) {
        logger.debug("onProgress callback error ignored", { error: cbErr.message });
      }
    }
  };

  activeSyncPromise = (async () => {
    let currentStage = 0;
    let currentStep = "Step 0 - Refreshing Materialized Views";

    try {
      const statements = await loadWperfStatements(sqlFilePath);
      if (statements.length < 5) {
        throw new Error(
          `Format SQL tidak sesuai: diharapkan minimal 5 statement (4 refresh MV + level queries), ditemukan ${statements.length}`,
        );
      }

      // TAHAP 0: Refresh 4 Materialized Views bertahap
      logger.info("WPERF sync: Step 0 - Refreshing Materialized Views (4 MVs)");
      await notify(0, 0);

      const mvSteps = [
        { key: "region", label: "Region", stmtIndex: 0, startPercent: 0, donePercent: 12 },
        { key: "nop", label: "NOP", stmtIndex: 1, startPercent: 12, donePercent: 25 },
        { key: "kabupaten", label: "Kabupaten", stmtIndex: 2, startPercent: 25, donePercent: 37 },
        { key: "kecamatan", label: "Kecamatan", stmtIndex: 3, startPercent: 37, donePercent: 50 },
      ];

      for (const mv of mvSteps) {
        currentStep = `Step 0 - Refresh MV ${mv.label}`;
        logger.info(`WPERF sync: Refreshing MV ${mv.label}...`);
        mvDetails[mv.key].status = "processing";
        await notify(0, mv.startPercent);

        const mvStart = Date.now();
        await queryFn(statements[mv.stmtIndex]);
        const mvDuration = Math.max(1, Math.round((Date.now() - mvStart) / 1000));

        mvDetails[mv.key].status = "done";
        mvDetails[mv.key].durationSec = mvDuration;
        logger.info(`WPERF sync: MV ${mv.label} refreshed in ${mvDuration}s`);
        await notify(0, mv.donePercent);
      }

      // TAHAP 1: Region Level (62%)
      currentStage = 1;
      currentStep = "Step 1 - Updating Region level";
      logger.info("WPERF sync: Step 1 - Updating Region level");
      await notify(1, 50);
      const regionRes = await queryFn(statements[4]);
      rowCounts.region = regionRes?.rowCount ?? 0;
      await notify(1, 62);

      // TAHAP 2: NOP Level (75%)
      currentStage = 2;
      currentStep = "Step 2 - Updating NOP level";
      logger.info("WPERF sync: Step 2 - Updating NOP level");
      await notify(2, 62);
      const nopRes = await queryFn(statements[5]);
      rowCounts.nop = nopRes?.rowCount ?? 0;
      await notify(2, 75);

      // TAHAP 3: Kabupaten Level (87%)
      currentStage = 3;
      currentStep = "Step 3 - Updating Kabupaten level";
      logger.info("WPERF sync: Step 3 - Updating Kabupaten level");
      await notify(3, 75);
      const kabRes = await queryFn(statements[6]);
      rowCounts.kabupaten = kabRes?.rowCount ?? 0;
      await notify(3, 87);

      // TAHAP 4: Kecamatan Level (100%)
      currentStage = 4;
      currentStep = "Step 4 - Updating Kecamatan level";
      logger.info("WPERF sync: Step 4 - Updating Kecamatan level");
      await notify(4, 87);
      const kecRes = await queryFn(statements[7]);
      rowCounts.kecamatan = kecRes?.rowCount ?? 0;

      // Selesai
      await notify(4, 100, true, null);

      logger.info("WPERF sync completed successfully", {
        durationSec: getDurationSec(),
        rowCounts,
        mvDetails,
      });

      return {
        success: true,
        durationSec: getDurationSec(),
        rowCounts,
        mvDetails,
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
    const lastSentText = new Map();
    const syncStartTime = Date.now();
    let lastProgressState = null;

    // kirim pesan awal ke target admin
    for (const chatId of targetChatIds) {
      try {
        const rich = createTelegramRichMessage(initialMessage);
        const res = await telegramBot.sendMessage(chatId, rich.text, rich.options);
        const msgId = res?.message_id;
        if (msgId) {
          messageTracker.set(String(chatId), msgId);
          lastSentText.set(String(chatId), rich.text);
        }
      } catch (sendErr) {
        logger.warn("Failed to send initial WPERF status message", {
          chatId,
          error: sendErr.message,
        });
      }
    }

    const onProgress = async (progressState) => {
      lastProgressState = progressState;
      const text = formatWperfProgressMessage(progressState);
      const rich = createTelegramRichMessage(text);

      for (const [chatId, msgId] of messageTracker.entries()) {
        if (lastSentText.get(chatId) === rich.text) {
          continue; // Hindari edit redundan jika isi teks sama persis
        }
        try {
          if (typeof telegramBot.editMessageText === "function") {
            await telegramBot.editMessageText(chatId, msgId, rich.text, rich.options);
            lastSentText.set(chatId, rich.text);
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

    // Heartbeat ticker: setiap 3 detik memperbarui durasi berjalan di Telegram
    // agar waktu tetap berdetik secara real-time meskipun query database sedang berjalan lama
    const ticker = setInterval(async () => {
      if (!lastProgressState || lastProgressState.isDone || lastProgressState.error) {
        return;
      }
      const elapsedSec = Math.round((Date.now() - syncStartTime) / 1000);
      try {
        await onProgress({
          ...lastProgressState,
          durationSec: elapsedSec,
        });
      } catch {}
    }, 3000);

    try {
      return await executeWperfSync({
        sqlFilePath,
        queryFn,
        onProgress,
      });
    } finally {
      clearInterval(ticker);
    }
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
