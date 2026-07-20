import { createLogger } from "../utils/logger.js";

const logger = createLogger("messageQueueService");

const MESSAGE_DELAY_MS = Number(process.env.WA_SEND_DELAY_MS || 5000);
const BATCH_SIZE = Number(process.env.WA_BATCH_SIZE || 10);
const BATCH_EXTRA_DELAY_MS = Number(process.env.WA_BATCH_EXTRA_DELAY_MS || 5000);

let queue = Promise.resolve();
const sentCountByAssignment = new Map();

// jeda async sederhana untuk menghindari pola blast pesan WhatsApp.
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// menghitung jeda setelah pesan terkirim, termasuk extra delay setiap 10 tiket per assignment.
function getPostSendDelay(assignmentType) {
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
  queue = queue
    .catch((error) => {
      logger.error("Previous queue task failed, continuing queue", error);
    })
    .then(async () => {
      logger.info("Sending queued ticket message", meta);
      await sendFn();

      const delayMs = getPostSendDelay(meta.assignmentType);
      if (delayMs > 0) {
        logger.info("Waiting before next queued ticket message", {
          delayMs,
          orderId: meta.orderId,
          assignmentType: meta.assignmentType,
        });
        await sleep(delayMs);
      }
    });

  return queue;
}
