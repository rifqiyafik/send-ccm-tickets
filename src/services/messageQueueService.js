import { createLogger } from "../utils/logger.js";

const logger = createLogger("messageQueueService");

const MESSAGE_DELAY_MS = Number(process.env.WA_SEND_DELAY_MS || 5000);
const BATCH_SIZE = Number(process.env.WA_BATCH_SIZE || 10);
const BATCH_EXTRA_DELAY_MS = Number(process.env.WA_BATCH_EXTRA_DELAY_MS || 5000);
const MANUAL_SEND_DELAY_MS = Number(process.env.TELEGRAM_SEND_DELAY_MS || 1500);

let queue = Promise.resolve();
const sentCountByAssignment = new Map();
let isCancelled = false;
let currentSleepTimer = null;
let currentSleepResolve = null;

// jeda async dengan kemampuan interrupt seketika saat cancel.
function interruptibleSleep(ms) {
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

// menghitung jeda setelah pesan terkirim, termasuk extra delay setiap 10 tiket per assignment.
function getPostSendDelay(assignmentType, options = {}) {
  if (options.manualMode) {
    return MANUAL_SEND_DELAY_MS;
  }

  const key = String(assignmentType || "UNKNOWN").toUpperCase();
  const sentCount = (sentCountByAssignment.get(key) || 0) + 1;
  sentCountByAssignment.set(key, sentCount);

  const isBatchBoundary = BATCH_SIZE > 0 && sentCount % BATCH_SIZE === 0;
  const delayMs = MESSAGE_DELAY_MS + (isBatchBoundary ? BATCH_EXTRA_DELAY_MS : 0);

  logger.info("Message queue delay calculated", {
    assignmentType: key,
    sentCount,
    batchSize: BATCH_SIZE,
    delayMs,
    isBatchBoundary,
  });

  return delayMs;
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

      logger.info("Sending queued ticket message", meta);
      await sendFn();

      if (isCancelled) return;

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
