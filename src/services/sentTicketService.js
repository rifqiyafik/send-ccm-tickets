import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";
import { cleanTableValue } from "../utils/text.js";

const logger = createLogger("sentTicketService");
const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "sent_tickets.json");
const DEFAULT_RETENTION_DAYS = 7;

function getStorePath() {
  return process.env.SENT_TICKET_STORE_PATH || DEFAULT_STORE_PATH;
}

function getRetentionDays() {
  const value = Number(process.env.SENT_TICKET_RETENTION_DAYS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

function normalizeOrderId(value) {
  return cleanTableValue(value).toUpperCase();
}

function normalizeBusinessStatus(value) {
  return cleanTableValue(value)
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
}

function isInProgress(value) {
  return normalizeBusinessStatus(value) === "INPROGRESS";
}

function isReopen(value) {
  return normalizeBusinessStatus(value) === "REOPEN";
}

function createEmptyStore() {
  return {
    version: 1,
    tickets: {},
  };
}

async function readStore() {
  const storePath = getStorePath();
  try {
    logger.info("Loading sent ticket store", { storePath });
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      tickets: parsed.tickets || {},
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info("Sent ticket store not found, starting empty", { storePath });
      return createEmptyStore();
    }

    logger.error("Failed to load sent ticket store", error);
    throw error;
  }
}

async function writeStore(store) {
  const storePath = getStorePath();
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    logger.info("Sent ticket store saved", {
      storePath,
      tickets: Object.keys(store.tickets || {}).length,
    });
  } catch (error) {
    logger.error("Failed to save sent ticket store", error);
    throw error;
  }
}

function cleanupExpiredRecords(store, now = new Date()) {
  const retentionDays = getRetentionDays();
  const cutoffTime = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const tickets = {};
  let removed = 0;

  for (const [orderId, record] of Object.entries(store.tickets || {})) {
    const sentAt = Date.parse(record.sent_at || "");
    if (Number.isFinite(sentAt) && sentAt < cutoffTime) {
      removed += 1;
      continue;
    }

    tickets[orderId] = record;
  }

  logger.info("Sent ticket store cleanup completed", {
    retentionDays,
    before: Object.keys(store.tickets || {}).length,
    after: Object.keys(tickets).length,
    removed,
  });

  return {
    ...store,
    tickets,
  };
}

function resolveTicketSendDecision(ticket, existingRecord) {
  const orderId = normalizeOrderId(ticket.order_id);

  if (!orderId || orderId === "-") {
    return {
      send: true,
      reason: "NO_ORDER_ID",
    };
  }

  if (ticket.sla_status !== "IN SLA") {
    return {
      send: false,
      reason: "OUT_SLA",
    };
  }

  if (!existingRecord) {
    return {
      send: true,
      reason: "NEW_IN_SLA",
    };
  }

  if (isInProgress(existingRecord.business_status) && isReopen(ticket.business_status)) {
    return {
      send: true,
      reason: "REOPEN_AFTER_IN_PROGRESS",
    };
  }

  return {
    send: false,
    reason: "DUPLICATE_ORDER_ID",
  };
}

// membersihkan riwayat lama, lalu memisahkan tiket yang boleh dikirim dan tiket yang harus dilewati.
export async function createSentTicketPlan(tickets, now = new Date()) {
  const rawStore = await readStore();
  const store = cleanupExpiredRecords(rawStore, now);
  await writeStore(store);

  const sendableTickets = [];
  const duplicateTickets = [];
  const outSlaTickets = [];
  const reopenedTickets = [];

  for (const ticket of tickets) {
    const orderId = normalizeOrderId(ticket.order_id);
    const existingRecord = store.tickets[orderId];
    const decision = resolveTicketSendDecision(ticket, existingRecord);

    logger.info("Sent ticket decision resolved", {
      orderId: ticket.order_id,
      slaStatus: ticket.sla_status,
      businessStatus: ticket.business_status,
      existingBusinessStatus: existingRecord?.business_status,
      decision: decision.reason,
      send: decision.send,
    });

    if (decision.send) {
      sendableTickets.push(ticket);
      if (decision.reason === "REOPEN_AFTER_IN_PROGRESS") {
        reopenedTickets.push(ticket);
      }
      continue;
    }

    if (decision.reason === "OUT_SLA") {
      outSlaTickets.push(ticket);
      continue;
    }

    duplicateTickets.push(ticket);
  }

  const plan = {
    sendable_tickets: sendableTickets,
    duplicate_tickets: duplicateTickets,
    out_sla_tickets: outSlaTickets,
    reopened_tickets: reopenedTickets,
    retention_days: getRetentionDays(),
  };

  logger.info("Sent ticket plan created", {
    total: tickets.length,
    sendable: sendableTickets.length,
    duplicate: duplicateTickets.length,
    outSla: outSlaTickets.length,
    reopened: reopenedTickets.length,
    retentionDays: plan.retention_days,
  });

  return plan;
}

// mencatat tiket hanya setelah pesan detail berhasil dikirim ke grup target.
export async function markTicketAsSent(ticket, metadata = {}) {
  const orderId = normalizeOrderId(ticket.order_id);
  if (!orderId || orderId === "-") {
    logger.warn("Sent ticket record skipped: order ID is empty", {
      orderId: ticket.order_id,
    });
    return;
  }

  const rawStore = await readStore();
  const store = cleanupExpiredRecords(rawStore);
  store.tickets[orderId] = {
    order_id: ticket.order_id,
    assignment_type: ticket.assignment_type,
    business_status: ticket.business_status,
    sla_status: ticket.sla_status,
    target_jid: metadata.targetJid || "",
    source_jid: metadata.sourceJid || "",
    sent_at: new Date().toISOString(),
  };

  logger.info("Marking ticket as sent", {
    orderId: ticket.order_id,
    businessStatus: ticket.business_status,
    slaStatus: ticket.sla_status,
    targetJid: metadata.targetJid,
  });

  await writeStore(store);
}

export function formatSentTicketPlanReport(plan) {
  const lines = [
    "Deduplication report:",
    `Tiket baru dikirim: ${plan.sendable_tickets.length}`,
    `Tiket duplicate dilewati: ${plan.duplicate_tickets.length}`,
    `Tiket OUT SLA dilewati: ${plan.out_sla_tickets.length}`,
    `Tiket ReOpen dikirim ulang: ${plan.reopened_tickets.length}`,
    `Retensi riwayat lokal: ${plan.retention_days} hari`,
  ];

  if (plan.duplicate_tickets.length > 0) {
    lines.push(
      "",
      "Duplicate Order ID:",
      ...plan.duplicate_tickets.map((ticket) => `- ${ticket.order_id || "-"}`),
    );
  }

  if (plan.out_sla_tickets.length > 0) {
    lines.push(
      "",
      "OUT SLA Order ID:",
      ...plan.out_sla_tickets.map((ticket) => `- ${ticket.order_id || "-"}`),
    );
  }

  if (plan.reopened_tickets.length > 0) {
    lines.push(
      "",
      "ReOpen dikirim ulang:",
      ...plan.reopened_tickets.map((ticket) => `- ${ticket.order_id || "-"}`),
    );
  }

  return lines.join("\n");
}
