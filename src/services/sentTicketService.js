import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";
import { cleanTableValue } from "../utils/text.js";

const logger = createLogger("sentTicketService");
const DEFAULT_STORE_PATH = path.join(
  process.cwd(),
  "data",
  "runtime",
  "sent_tickets.json",
);
const DEFAULT_RETENTION_DAYS = 7;
const LOCAL_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";

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

function formatLocalDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function toTitleCase(value) {
  return cleanTableValue(value)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPicLabel(value) {
  const pic = cleanTableValue(value);
  if (!pic || pic === "-") {
    return "-";
  }
  return pic.toLowerCase().startsWith("bg ") ? pic : `Bg ${pic}`;
}

function resolveSqaFollowUpDepartment(ticket) {
  const department = cleanTableValue(
    ticket.departemen_ns || ticket.departement_ns || ticket.cluster_area,
  )
    .replace(/^NOP\s+/i, "")
    .trim();

  return department && department !== "-"
    ? department
    : cleanTableValue(ticket.nsa || "UNKNOWN");
}

function createCodeTable(columns, rows) {
  const normalizedRows = rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => [
        column.key,
        cleanTableValue(row[column.key]),
      ]),
    ),
  );
  const widths = Object.fromEntries(
    columns.map((column) => [
      column.key,
      Math.max(
        column.header.length,
        ...normalizedRows.map((row) => row[column.key].length),
      ),
    ]),
  );
  const border = `+${columns
    .map((column) => "-".repeat(widths[column.key] + 2))
    .join("+")}+`;
  const header = `| ${columns
    .map((column) => column.header.padEnd(widths[column.key]))
    .join(" | ")} |`;
  const tableRows = normalizedRows.map(
    (row) =>
      `| ${columns
        .map((column) => row[column.key].padEnd(widths[column.key]))
        .join(" | ")} |`,
  );

  return ["```", border, header, border, ...tableRows, border, "```"].join(
    "\n",
  );
}

function createOrderIdCodeTable(tickets) {
  return createCodeTable(
    [{ key: "orderId", header: "Order ID" }],
    tickets.map((ticket) => ({ orderId: ticket.order_id })),
  );
}

function createInvalidMessageDataCodeTable(tickets) {
  return createCodeTable(
    [
      { key: "orderId", header: "Order ID" },
      { key: "missingData", header: "Missing Data" },
    ],
    tickets.map((ticket) => ({
      orderId: ticket.order_id,
      missingData: (ticket.missing_fields || []).join(", "),
    })),
  );
}

function createResolvedFallbackDataCodeTable(tickets) {
  return createCodeTable(
    [
      { key: "orderId", header: "Order ID" },
      { key: "field", header: "Field" },
      { key: "fallback", header: "Fallback" },
      { key: "missing", header: "Field Kosong Fallback" },
    ],
    tickets.flatMap((ticket) =>
      (ticket.fallback_resolutions || []).map((resolution) => ({
        orderId: ticket.order_id,
        field: resolution.field,
        fallback: resolution.source,
        missing: (resolution.missing_fields || []).join(", "),
      })),
    ),
  );
}

function isInProgress(value) {
  return normalizeBusinessStatus(value) === "INPROGRESS";
}

function isReopen(value) {
  return normalizeBusinessStatus(value) === "REOPEN";
}

function isOutSla(ticket) {
  return cleanTableValue(ticket.sla_status).toUpperCase() === "OUT SLA";
}

function isTicketValueEmpty(value) {
  const cleaned = cleanTableValue(value);
  return !cleaned || cleaned === "-";
}

function getExistingSentDate(record) {
  if (record?.sent_date) {
    return record.sent_date;
  }

  if (record?.sent_at) {
    return formatLocalDate(record.sent_at);
  }

  return "";
}

function getRequiredMessageFields(ticket) {
  const isSqa = ticket.assignment_type === "SQA";
  const isNop = ticket.assignment_type === "NOP";
  const required = ["order_id", "resolve_target_22h_text"];

  if (isSqa) {
    required.push("ccm_handling");
  }

  if (isNop) {
    required.push("pic_nop");
  }

  if (ticket.use_reopen_message_format) {
    required.push("reopen_number");
    if (isSqa) {
      required.push("pic_sqa");
    }
    return required;
  }

  if (isOutSla(ticket) && isInProgress(ticket.business_status)) {
    return required;
  }

  required.push("notes", "analysis_text");
  if (isSqa) {
    required.push("pic_sqa");
  }

  return required;
}

function validateTicketMessageData(ticket) {
  const missingFields = getRequiredMessageFields(ticket).filter((field) =>
    isTicketValueEmpty(ticket[field]),
  );

  return {
    ok: missingFields.length === 0,
    missing_fields: missingFields,
  };
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
    await fs.writeFile(
      storePath,
      `${JSON.stringify(store, null, 2)}\n`,
      "utf8",
    );
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

function resolveTicketSendDecision(ticket, existingRecord, today) {
  const orderId = normalizeOrderId(ticket.order_id);

  if (!orderId || orderId === "-") {
    return {
      send: false,
      reason: "INVALID_MESSAGE_DATA",
      missing_fields: ["order_id"],
    };
  }

  const validation = validateTicketMessageData(ticket);
  if (!validation.ok) {
    return {
      send: false,
      reason: "INVALID_MESSAGE_DATA",
      missing_fields: validation.missing_fields,
    };
  }

  if (!existingRecord) {
    return {
      send: true,
      reason: isOutSla(ticket) ? "OUT_SLA_REMINDER_TODAY" : "NEW_TODAY",
    };
  }

  const existingSentDate = getExistingSentDate(existingRecord);

  if (
    isInProgress(existingRecord.business_status) &&
    isReopen(ticket.business_status)
  ) {
    return {
      send: true,
      reason: "REOPEN_AFTER_IN_PROGRESS",
    };
  }

  if (existingSentDate !== today) {
    return {
      send: true,
      reason: isOutSla(ticket) ? "OUT_SLA_REMINDER_TODAY" : "SENT_PREVIOUS_DAY",
    };
  }

  return {
    send: false,
    reason: "DUPLICATE_TODAY",
  };
}

// membersihkan riwayat lama, lalu memisahkan tiket yang boleh dikirim dan tiket yang harus dilewati.
export async function createSentTicketPlan(tickets, now = new Date()) {
  const rawStore = await readStore();
  const store = cleanupExpiredRecords(rawStore, now);
  await writeStore(store);
  const today = formatLocalDate(now);

  const sendableTickets = [];
  const duplicateTickets = [];
  const outSlaTickets = [];
  const reopenedTickets = [];
  const invalidMessageTickets = [];

  for (const ticket of tickets) {
    const orderId = normalizeOrderId(ticket.order_id);
    const existingRecord = store.tickets[orderId];
    const decision = resolveTicketSendDecision(ticket, existingRecord, today);

    logger.info("Sent ticket decision resolved", {
      orderId: ticket.order_id,
      slaStatus: ticket.sla_status,
      businessStatus: ticket.business_status,
      existingBusinessStatus: existingRecord?.business_status,
      existingSentDate: getExistingSentDate(existingRecord),
      today,
      decision: decision.reason,
      send: decision.send,
      missingFields: decision.missing_fields,
    });

    if (decision.send) {
      sendableTickets.push(ticket);
      if (decision.reason === "REOPEN_AFTER_IN_PROGRESS") {
        reopenedTickets.push(ticket);
      }
      if (decision.reason === "OUT_SLA_REMINDER_TODAY") {
        outSlaTickets.push(ticket);
      }
      continue;
    }

    if (decision.reason === "INVALID_MESSAGE_DATA") {
      invalidMessageTickets.push({
        ...ticket,
        missing_fields: decision.missing_fields,
      });
      continue;
    }

    duplicateTickets.push(ticket);
  }

  const plan = {
    sendable_tickets: sendableTickets,
    duplicate_tickets: duplicateTickets,
    out_sla_tickets: outSlaTickets,
    reopened_tickets: reopenedTickets,
    invalid_message_tickets: invalidMessageTickets,
    fallback_resolved_tickets: sendableTickets.filter(
      (ticket) => (ticket.fallback_resolutions || []).length > 0,
    ),
    retention_days: getRetentionDays(),
    sent_date: today,
  };

  logger.info("Sent ticket plan created", {
    total: tickets.length,
    sendable: sendableTickets.length,
    duplicate: duplicateTickets.length,
    outSla: outSlaTickets.length,
    reopened: reopenedTickets.length,
    invalidMessageData: invalidMessageTickets.length,
    fallbackResolved: plan.fallback_resolved_tickets.length,
    sentDate: today,
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
  const now = new Date();
  store.tickets[orderId] = {
    order_id: ticket.order_id,
    assignment_type: ticket.assignment_type,
    business_status: ticket.business_status,
    sla_status: ticket.sla_status,
    target_jid: metadata.targetJid || "",
    source_jid: metadata.sourceJid || "",
    sent_at: now.toISOString(),
    sent_date: formatLocalDate(now),
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
  const invalidMessageTickets = plan.invalid_message_tickets || [];
  const fallbackResolvedTickets = plan.fallback_resolved_tickets || [];
  const newTicketCount = Math.max(
    0,
    plan.sendable_tickets.length -
      plan.out_sla_tickets.length -
      plan.reopened_tickets.length,
  );
  const reportLines = [
    "📊 Rekapitulasi Tiket",
    "",
    `🆕 Tiket Baru Terkirim: ${newTicketCount}`,
    `🔁 Tiket Sudah Pernah Dikirim Hari Ini: ${plan.duplicate_tickets.length}`,
    `⏱️ Tiket OUT SLA (Reminding): ${plan.out_sla_tickets.length}`,
    `🟡 Data Tidak Lengkap yang Dikirim: ${fallbackResolvedTickets.length}`,
    `🔴 Data Tidak Lengkap Butuh Bantuan: ${invalidMessageTickets.length}`,
    `♻️ Tiket ReOpen dikirim ulang: ${plan.reopened_tickets.length}`,
    `🗄️ Retensi Data Lokal: ${plan.retention_days} hari`,
  ];

  if (plan.duplicate_tickets.length > 0) {
    reportLines.push(
      "",
      "🔁 Tiket Sudah Pernah Dikirim Hari Ini:",
      "",
      createOrderIdCodeTable(plan.duplicate_tickets),
    );
  }

  if (plan.out_sla_tickets.length > 0) {
    reportLines.push(
      "",
      "⏱️ Tiket OUT SLA (Reminding):",
      "",
      createOrderIdCodeTable(plan.out_sla_tickets),
    );
  }

  if (fallbackResolvedTickets.length > 0) {
    reportLines.push(
      "",
      "🟡 Data Tidak Lengkap yang Dikirim:",
      "",
      createResolvedFallbackDataCodeTable(fallbackResolvedTickets),
    );
  }

  if (invalidMessageTickets.length > 0) {
    reportLines.push(
      "",
      "🔴 Data Tidak Lengkap Butuh Bantuan:",
      "",
      createInvalidMessageDataCodeTable(invalidMessageTickets),
    );
  }

  if (plan.reopened_tickets.length > 0) {
    reportLines.push(
      "",
      "♻️ Tiket ReOpen dikirim ulang:",
      "",
      createOrderIdCodeTable(plan.reopened_tickets),
    );
  }

  return reportLines.join("\n");
}

export function formatSqaAreaFollowUpMessage(tickets) {
  const sqaTickets = tickets.filter(
    (ticket) => ticket.assignment_type === "SQA",
  );
  if (sqaTickets.length === 0) {
    return "";
  }

  const areaMap = new Map();
  for (const ticket of sqaTickets) {
    const department = resolveSqaFollowUpDepartment(ticket);
    const key = [
      department.toUpperCase(),
      cleanTableValue(ticket.pic_sqa || ticket.pic).toUpperCase(),
    ].join("|");
    const existing = areaMap.get(key) || {
      department: toTitleCase(department),
      pic: formatPicLabel(ticket.pic_sqa || ticket.pic),
      count: 0,
    };

    existing.count += 1;
    if (existing.pic === "-" && (ticket.pic_sqa || ticket.pic)) {
      existing.pic = formatPicLabel(ticket.pic_sqa || ticket.pic);
    }
    areaMap.set(key, existing);
  }

  const areaLines = [...areaMap.values()]
    .sort(
      (a, b) =>
        a.department.localeCompare(b.department) || a.pic.localeCompare(b.pic),
    )
    .map(
      (item) => `${item.count} tiket SQA area ${item.department} (${item.pic})`,
    );

  return [
    "Assalamualaikum,",
    "Semangat Pagi dan Semangat Sehat,",
    "Dear Bapak Manager dan SQA Team ,",
    "Berikut kami infokan tiket Remedy Customer Complaint yg masih open di SQA,",
    "",
    "Mohon dibantu untuk segera di follow up.",
    ...areaLines,
    "",
    "Terimakasih sebelumnya 🙏🏻😇",
  ].join("\n");
}
