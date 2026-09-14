import { queryDatabase, isDatabaseConfigured } from "./databaseService.js";
import { createLogger } from "../utils/logger.js";
import { cleanTableValue } from "../utils/text.js";
import { shortenNopName } from "./ticketImportService.js";

const logger = createLogger("inapTicketStore");

const LOCAL_TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Jakarta";
const DEFAULT_SCHEMA = process.env.PG_SCHEMA || "SQA_SUMBAGUT";
const MASTER_TABLE = process.env.PG_TABLE_TICKETS || "inap_ticketing_customer_complain";
const SENT_TABLE = process.env.PG_TABLE_SENT_HISTORY || "inap_sent_tickets_history";

// mengonversi header Excel atau nama kolom mentah ke snake_case standar PostgreSQL
export function toSnakeCase(str) {
  if (!str) return "";
  let s = String(str)
    .replace(/[\(\)\/\?\:\-\.\,]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .toLowerCase();
  s = s.replace(/_+/g, "_");
  s = s.replace(/^_+|_+$/g, "");
  return s;
}

// memformat tanggal hari ini ke YYYY-MM-DD zona waktu lokal WIB
export function getWibDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

// menghitung batas waktu H-1 pukul 00:00:00 WIB untuk window polling
export function getHMinusOneWatermark(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const yesterday = new Date(d.getTime() - 24 * 60 * 60 * 1000);
  const dateStr = getWibDateString(yesterday);
  return `${dateStr} 00:00:00`;
}

// menentukan target eskalasi efektif untuk pencatatan di riwayat
export function resolveEffectiveTarget(ticket) {
  if (!ticket) return "";
  if (
    ticket.is_repetitive ||
    ticket.targetGroupKey === "SITE VISIT" ||
    ticket.assignment_type === "SITE_VISIT"
  ) {
    return "SITE VISIT";
  }
  if (ticket.assignment_type === "SQA") {
    return "SQA";
  }
  if (ticket.assignment_type === "NOP") {
    return shortenNopName(
      ticket.cluster_area ||
        ticket.nsa ||
        ticket.assignment_group ||
        "NOP",
    );
  }
  if (ticket.cluster_area || ticket.assignment_group) {
    return shortenNopName(ticket.cluster_area || ticket.assignment_group);
  }
  return "";
}

// mengonversi baris Excel ke object ber-key snake_case
export function convertRowToSnakeCase(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    const snake = toSnakeCase(key);
    if (snake) {
      result[snake] = value;
    }
  }
  return result;
}

// membersihkan nilai sel untuk tipe data non-TEXT di PostgreSQL
function sanitizeCellValue(snakeKey, value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str === "-" || str.toLowerCase() === "null") {
    return null;
  }

  // Tipe numerik atau koordinat
  if (snakeKey === "latitude_l2_assign" || snakeKey === "longitude_l2_assign") {
    const num = Number(str);
    return Number.isFinite(num) ? num : null;
  }

  if (
    snakeKey === "reopen_number_confirm_close" ||
    snakeKey === "reassign_number_l2_assign" ||
    snakeKey === "order_seq"
  ) {
    const num = parseInt(str, 10);
    return Number.isInteger(num) ? num : null;
  }

  return str;
}

// melakukan bulk upsert data tiket 208 kolom ke tabel master PostgreSQL
export async function batchUpsertMasterTickets(rows, options = {}) {
  if (!rows || rows.length === 0) {
    return { total: 0, processed: 0, inserted: 0, updated: 0 };
  }

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || MASTER_TABLE;
  const fullTableName = `"${schema}".${table}`;

  logger.info("Starting batch upsert of master tickets", {
    rowCount: rows.length,
    table: fullTableName,
  });

  const chunkSize = options.chunkSize || 100;
  let totalProcessed = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    for (const rawRow of chunk) {
      const row = convertRowToSnakeCase(rawRow);
      const orderId = String(row.order_id || "").trim();
      if (!orderId || orderId === "-") continue;

      const keys = Object.keys(row).filter((k) => k !== "created_at" && k !== "updated_at");
      const values = keys.map((k) => sanitizeCellValue(k, row[k]));

      // Tambahkan updated_at = NOW()
      const columnList = [...keys, "updated_at"].map((k) => `"${k}"`).join(", ");
      const placeholders = keys.map((_, idx) => `$${idx + 1}`).concat(["NOW()"]).join(", ");

      const updateSet = keys
        .filter((k) => k !== "order_id")
        .map((k, idx) => `"${k}" = EXCLUDED."${k}"`)
        .concat(['"updated_at" = NOW()'])
        .join(", ");

      const sql = `
        INSERT INTO ${fullTableName} (${columnList})
        VALUES (${placeholders})
        ON CONFLICT ("order_id") DO UPDATE SET
          ${updateSet};
      `;

      await queryDatabase(sql, values);
      totalProcessed += 1;
    }
  }

  logger.info("Batch upsert completed", {
    totalRows: rows.length,
    processed: totalProcessed,
  });

  return { total: rows.length, processed: totalProcessed };
}

// memformat tanggal ke format string ISO YYYY-MM-DD yang aman dan konsisten
export function formatIsoDateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const str = String(value).trim();
  const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) {
    return match[1];
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return str.slice(0, 10);
}

// memuat status riwayat pengiriman tiket dari tabel inap_sent_tickets_history untuk deduplikasi
export async function loadSentTicketMap(orderIds, options = {}) {
  const sentMap = new Map();
  if (!orderIds || orderIds.length === 0) {
    return sentMap;
  }

  const cleanOrderIds = orderIds
    .map((id) => cleanTableValue(id).toUpperCase())
    .filter((id) => Boolean(id) && id !== "-");

  if (cleanOrderIds.length === 0) {
    return sentMap;
  }

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || SENT_TABLE;
  const fullTableName = `"${schema}".${table}`;

  const sql = `
    SELECT DISTINCT ON ("order_id")
      id,
      "order_id",
      dispatch_type,
      sent_at::text AS sent_at,
      sent_date::text AS sent_date,
      target_whatsapp_group_jid,
      source_request_jid,
      assigned_pic,
      target_destination,
      sla_status,
      business_status,
      reopen_count,
      is_repetitive,
      sent_to_site_visit,
      site_visit_sent_at::text AS site_visit_sent_at,
      site_visit_target_jid,
      escalated_from_previous
    FROM ${fullTableName}
    WHERE UPPER("order_id") = ANY($1::text[])
    ORDER BY "order_id", sent_at DESC;
  `;

  try {
    const result = await queryDatabase(sql, [cleanOrderIds]);
    for (const row of result.rows || []) {
      const normalizedId = String(row.order_id || "").trim().toUpperCase();
      sentMap.set(normalizedId, {
        order_id: row.order_id,
        assignment_type: row.target_destination === "SQA" ? "SQA" : "NOP",
        assignment_group: row.target_destination || "",
        cluster_area: row.target_destination || "",
        effective_target: row.target_destination || "",
        business_status: row.business_status || "",
        sla_status: row.sla_status || "",
        reopen_count: Number(row.reopen_count || 0),
        is_repetitive: Boolean(row.is_repetitive),
        sent_to_site_visit: Boolean(row.sent_to_site_visit),
        site_visit_sent_at: row.site_visit_sent_at ? new Date(row.site_visit_sent_at).toISOString() : "",
        site_visit_target_jid: row.site_visit_target_jid || "",
        escalated_from: row.escalated_from_previous || "",
        target_jid: row.target_whatsapp_group_jid || "",
        source_jid: row.source_request_jid || "",
        sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : "",
        sent_date: formatIsoDateOnly(row.sent_date),
      });
    }

    logger.info("Loaded sent ticket map from PostgreSQL", {
      requested: cleanOrderIds.length,
      found: sentMap.size,
    });
  } catch (error) {
    logger.error("Failed to load sent ticket map from PostgreSQL", {
      message: error.message,
    });
    throw error;
  }

  return sentMap;
}

// mencatat riwayat tiket yang berhasil dikirim ke tabel inap_sent_tickets_history
export async function recordSentTickets(tickets, metadata = {}, options = {}) {
  if (!tickets || tickets.length === 0) return;

  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || SENT_TABLE;
  const fullTableName = `"${schema}".${table}`;
  const now = new Date();
  const todayWib = getWibDateString(now);

  logger.info("Recording sent tickets to PostgreSQL history", {
    count: tickets.length,
    table: fullTableName,
  });

  for (const ticket of tickets) {
    const orderId = String(ticket.order_id || "").trim();
    if (!orderId || orderId === "-") continue;

    const reopenCountValue = Number(cleanTableValue(ticket.reopen_number));
    const reopenCount =
      Number.isFinite(reopenCountValue) && Number.isInteger(reopenCountValue)
        ? reopenCountValue
        : 0;

    const effectiveTarget = resolveEffectiveTarget(ticket);
    const isSiteVisit =
      effectiveTarget === "SITE VISIT" || Boolean(ticket.is_repetitive);

    const dispatchType = ticket.escalated_from
      ? "REASSIGNMENT"
      : ticket.use_reopen_message_format
      ? "REOPEN"
      : isSiteVisit
      ? "SITE_VISIT"
      : "INITIAL";

    const masterTable = options.masterTable || MASTER_TABLE;
    const fullMasterTableName = `"${schema}".${masterTable}`;

    // Pastikan order_id sudah ada di master table untuk memenuhi foreign key constraint
    try {
      await queryDatabase(
        `INSERT INTO ${fullMasterTableName} ("order_id", created_at, updated_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT ("order_id") DO NOTHING;`,
        [orderId],
      );
    } catch (stubErr) {
      logger.warn("Failed to ensure master ticket stub in PostgreSQL", {
        orderId,
        error: stubErr.message,
      });
    }

    const sql = `
      INSERT INTO ${fullTableName} (
        "order_id",
        dispatch_type,
        sent_at,
        sent_date,
        target_whatsapp_group_jid,
        source_request_jid,
        assigned_pic,
        target_destination,
        sla_status,
        business_status,
        reopen_count,
        is_repetitive,
        sent_to_site_visit,
        site_visit_sent_at,
        site_visit_target_jid,
        escalated_from_previous
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16);
    `;

    const values = [
      orderId,
      dispatchType,
      now,
      todayWib,
      metadata.targetJid || "",
      metadata.sourceJid || "",
      ticket.pic || "",
      effectiveTarget,
      ticket.sla_status || "",
      ticket.business_status || "",
      reopenCount,
      Boolean(ticket.is_repetitive),
      Boolean(isSiteVisit || ticket.sent_to_site_visit),
      isSiteVisit ? now : null,
      isSiteVisit ? metadata.targetJid || "" : null,
      ticket.escalated_from || null,
    ];

    try {
      await queryDatabase(sql, values);
    } catch (error) {
      logger.error("Failed to record sent ticket history in PostgreSQL", {
        orderId,
        error: error.message,
      });
      throw error;
    }
  }

  logger.info("Successfully recorded sent tickets to PostgreSQL", {
    count: tickets.length,
  });
}
