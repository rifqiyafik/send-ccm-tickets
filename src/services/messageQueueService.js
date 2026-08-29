import { createLogger } from "../utils/logger.js";

const logger = createLogger("messageQueueService");

let queue = Promise.resolve();
const sentCountByAssignment = new Map();
let isCancelled = false;
let currentSleepTimer = null;
let currentSleepResolve = null;

// membaca konfigurasi delay dan pacing secara dinamis agar mendukung override .env dan runtime testing.
export function getQueueConfig() {
  const defaultMin = 8000;
  const defaultMax = 13000;

  const hasMin = process.env.WA_SEND_DELAY_MIN_MS !== undefined && process.env.WA_SEND_DELAY_MIN_MS !== "";
  const hasMax = process.env.WA_SEND_DELAY_MAX_MS !== undefined && process.env.WA_SEND_DELAY_MAX_MS !== "";
  const hasFixed = process.env.WA_SEND_DELAY_MS !== undefined && process.env.WA_SEND_DELAY_MS !== "";

  let minMs = defaultMin;
  let maxMs = defaultMax;

  if (hasMin || hasMax) {
    minMs = hasMin ? Number(process.env.WA_SEND_DELAY_MIN_MS) : defaultMin;
    maxMs = hasMax ? Number(process.env.WA_SEND_DELAY_MAX_MS) : Math.max(minMs, defaultMax);
  } else if (hasFixed) {
    const fixed = Number(process.env.WA_SEND_DELAY_MS);
    minMs = fixed;
    maxMs = fixed;
  }

  // memastikan min tidak lebih besar dari max
  const effectiveMin = Math.max(0, Math.min(minMs, maxMs));
  const effectiveMax = Math.max(0, Math.max(minMs, maxMs));

  return {
    minDelayMs: effectiveMin,
    maxDelayMs: effectiveMax,
    batchSize: Number(process.env.WA_BATCH_SIZE || 10),
    batchExtraDelayMs: Number(process.env.WA_BATCH_EXTRA_DELAY_MS || 5000),
    manualSendDelayMs: Number(process.env.TELEGRAM_SEND_DELAY_MS || 10000),
    maxRetries: Math.max(1, Number(process.env.WA_RETRY_MAX_ATTEMPTS || 3)),
    retryBackoffMs: Math.max(500, Number(process.env.WA_RETRY_BACKOFF_MS || 3000)),
  };
}

// jeda async dengan kemampuan interrupt seketika saat cancel.
function interruptibleSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    currentSleepResolve = resolve;
    currentSleepTimer = setTimeout(() => {
      currentSleepTimer = null;
      currentSleepResolve = null;
      resolve();
    }, ms);
  });
}

// membatalkan seluruh antrian pesan dan menghentikan delay yang sedang berjalan.
export function cancelQueue(reason = "Cancelled by user") {
  logger.warn("Message queue cancelled", { reason });
  isCancelled = true;

  if (currentSleepTimer) {
    clearTimeout(currentSleepTimer);
    currentSleepTimer = null;
  }
  if (currentSleepResolve) {
    currentSleepResolve();
    currentSleepResolve = null;
  }

  queue = Promise.resolve();
  sentCountByAssignment.clear();

  // Reset cancellation flag setelah microtask selesai agar send berikutnya bisa berjalan.
  setTimeout(() => {
    isCancelled = false;
  }, 100);

  return true;
}

export function isQueueCancelled() {
  return isCancelled;
}

// menghitung jeda acak human-typing (adaptive jitter) dan extra delay kelipatan batch.
export function getPostSendDelay(assignmentType, options = {}) {
  const config = getQueueConfig();

  if (options.manualMode) {
    return config.manualSendDelayMs;
  }

  const key = String(assignmentType || "UNKNOWN").toUpperCase();
  const sentCount = (sentCountByAssignment.get(key) || 0) + 1;
  sentCountByAssignment.set(key, sentCount);

  // Menghitung jitter acak seragam di rentang [minDelayMs, maxDelayMs]
  const jitterRange = config.maxDelayMs - config.minDelayMs;
  const randomOffset = jitterRange > 0 ? Math.floor(Math.random() * (jitterRange + 1)) : 0;
  const jitterDelayMs = config.minDelayMs + randomOffset;

  const isBatchBoundary = config.batchSize > 0 && sentCount % config.batchSize === 0;
  const batchExtraMs = isBatchBoundary ? config.batchExtraDelayMs : 0;
  const totalDelayMs = jitterDelayMs + batchExtraMs;

  logger.info("Message queue delay calculated", {
    assignmentType: key,
    sentCount,
    batchSize: config.batchSize,
    minDelayMs: config.minDelayMs,
    maxDelayMs: config.maxDelayMs,
    jitterDelayMs,
    batchExtraDelayMs: batchExtraMs,
    delayMs: totalDelayMs,
    isBatchBoundary,
  });

  return totalDelayMs;
}

// mengeksekusi fungsi pengiriman dengan auto-retry saat terjadi error/koneksi terputus.
export async function executeWithRetry(sendFn, meta = {}) {
  const config = getQueueConfig();
  const maxAttempts = config.maxRetries;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isCancelled) {
      logger.warn("executeWithRetry cancelled before attempt", { attempt, meta });
      return { ok: false, cancelled: true };
    }

    try {
      logger.info("Sending queued ticket message", { attempt, maxAttempts, ...meta });
      await sendFn();
      return { ok: true, attempts: attempt };
    } catch (error) {
      if (isCancelled) {
        logger.warn("executeWithRetry cancelled during error handling", { attempt, meta });
        return { ok: false, cancelled: true };
      }

      if (attempt < maxAttempts) {
        const retryDelayMs = config.retryBackoffMs * attempt;
        logger.warn("Sending queued ticket message failed, retrying", {
          attempt,
          maxAttempts,
          retryDelayMs,
          error: error.message,
          orderId: meta.orderId,
          assignmentType: meta.assignmentType,
        });
        await interruptibleSleep(retryDelayMs);
      } else {
        logger.error("Sending queued ticket message permanently failed after all attempts", {
          attempt,
          maxAttempts,
          error: error.message,
          orderId: meta.orderId,
          assignmentType: meta.assignmentType,
        });
        return { ok: false, error, attempts: attempt };
      }
    }
  }

  return { ok: false, attempts: maxAttempts };
}

// memasukkan pengiriman tiket ke antrian global agar upload bersamaan tetap terkirim berurutan.
export function enqueueTicketMessage(sendFn, meta = {}) {
  if (isCancelled) {
    logger.warn("enqueueTicketMessage skipped because queue is cancelled", meta);
    return Promise.resolve();
  }

  queue = queue
    .catch((error) => {
      logger.error("Previous queue task failed, continuing queue", error);
    })
    .then(async () => {
      if (isCancelled) {
        logger.warn("Skipping queued ticket message execution because queue is cancelled", meta);
        return;
      }

      const result = await executeWithRetry(sendFn, meta);
      if (isCancelled || !result.ok) {
        // Jika retry gagal total atau di-cancel, tetap catat dan lanjutkan ke tiket berikutnya tanpa crash
        return;
      }

      const delayMs = getPostSendDelay(meta.assignmentType, {
        manualMode: Boolean(meta.manualMode),
      });
      if (delayMs > 0) {
        logger.info("Waiting before next queued ticket message", {
          delayMs,
          orderId: meta.orderId,
          assignmentType: meta.assignmentType,
          manualMode: Boolean(meta.manualMode),
        });
        await interruptibleSleep(delayMs);
      }
    });

  return queue;
}
