import { isDatabaseConfigured, queryDatabase } from "./databaseService.js";
import { resolveSiteFromTicketRow } from "./siteSearchService.js";
import { cleanInlineText, cleanTableValue } from "../utils/text.js";
import {
  formatIndonesianDate,
  getWibDateString,
  parseDateTime,
} from "../utils/dateTime.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("siteRepetitiveService");

export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_SCHEMA = process.env.PG_SCHEMA || "SQA_SUMBAGUT";
export const MASTER_TABLE = "inap_ticketing_customer_complain";

/**
 * Memeriksa apakah status order tiket tergolong aktif/belum selesai.
 * Tiket dianggap aktif jika order_status bukan 'completed' (termasuk 'running', NULL, kosong, dsb).
 *
 * @param {string|null|undefined} orderStatus
 * @returns {boolean}
 */
export function isTicketActive(orderStatus) {
  if (orderStatus === null || orderStatus === undefined) {
    return true;
  }
  const s = String(orderStatus).trim().toLowerCase();
  if (!s || s === "null" || s === "-") {
    return true;
  }
  return s !== "completed";
}

/**
 * Mengekstrak Site ID yang valid dari objek tiket atau baris mentah.
 * Memvalidasi format dan menggunakan resolveSiteFromTicketRow jika kosong atau bernilai opaque.
 *
 * @param {object} ticket
 * @returns {string|null}
 */
export function extractTicketSiteId(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return null;
  }

  const rawRow = ticket.row_raw || ticket;

  let candidate =
    ticket.site_id ||
    ticket.site_id1_l1_assign ||
    ticket.site_id1 ||
    rawRow["site_id1(L1 Assign)"] ||
    rawRow.site_id1_l1_assign ||
    rawRow.site_id;

  candidate = String(candidate ?? "").trim().toUpperCase();

  const isOpaque =
    /^\d{6,}$/i.test(candidate) || /^[0-9A-F]{10,}$/i.test(candidate);

  if (!candidate || candidate === "-" || candidate === "NULL" || isOpaque) {
    try {
      const resolved = resolveSiteFromTicketRow(rawRow);
      if (resolved?.ok && resolved.site_id) {
        candidate = String(resolved.site_id).trim().toUpperCase();
      }
    } catch (_) {
      // Fallback aman jika resolver gagal
    }
  }

  if (
    !candidate ||
    candidate === "-" ||
    candidate === "NULL" ||
    /^\d{6,}$/i.test(candidate) ||
    /^[0-9A-F]{10,}$/i.test(candidate)
  ) {
    return null;
  }

  return candidate;
}

/**
 * Mengekstrak rincian komplain / gejala gangguan dari field-field tiket yang tersedia.
 *
 * @param {object} ticket
 * @param {number} [maxLength=140]
 * @returns {string}
 */
export function extractComplaintDetail(ticket, maxLength = 140) {
  if (!ticket || typeof ticket !== "object") {
    return "-";
  }

  const rawRow = ticket.row_raw || ticket;

  const rawCandidate =
    ticket.complaint_detail ||
    ticket.description_fault_sumptomps_create_ticket_description_fault_sym ||
    ticket.description_fault_sumptomps ||
    rawRow["Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"] ||
    rawRow.description_fault_sumptomps_create_ticket_description_fault_sym ||
    rawRow.description_fault_sumptomps ||
    ticket.raw_description ||
    ticket.description ||
    rawRow.Description ||
    rawRow.description ||
    ticket.notes ||
    "-";

  const cleaned = cleanInlineText(rawCandidate, "-");
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 3)}...`;
}

/**
 * Memformat waktu/tanggal pembuatan tiket untuk ditampilkan pada rincian komplain repetitif.
 *
 * @param {object} ticket
 * @returns {string}
 */
export function formatTicketTimestamp(ticket) {
  if (!ticket) return "-";
  const rawRow = ticket.row_raw || ticket;
  const rawDate =
    ticket.create_time ||
    ticket.date ||
    rawRow.create_time ||
    rawRow["Create Time"] ||
    rawRow.date ||
    rawRow.Date;

  const parsed = parseDateTime(rawDate);
  if (!parsed) {
    return cleanTableValue(rawDate || "-");
  }

  const dateStr = formatIndonesianDate(parsed, {
    includeDay: false,
    shortMonth: true,
  });

  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");

  if (hours !== "00" || minutes !== "00") {
    return `${dateStr} ${hours}:${minutes} WIB`;
  }
  return dateStr;
}

/**
 * Mengambil tiket aktif (order_status != 'completed') dalam rentang N hari ke belakang dari PostgreSQL.
 *
 * @param {string[]} siteIds
 * @param {object} [options={}]
 * @returns {Promise<Array>}
 */
export async function fetchRecentActiveTicketsFromDb(siteIds, options = {}) {
  if (
    !isDatabaseConfigured() ||
    !Array.isArray(siteIds) ||
    siteIds.length === 0
  ) {
    return [];
  }

  const days = Number(options.days || DEFAULT_LOOKBACK_DAYS);
  const schema = options.schema || DEFAULT_SCHEMA;
  const table = options.table || MASTER_TABLE;

  const refDate = options.referenceDate
    ? new Date(options.referenceDate)
    : new Date();
  const cutoffDate = new Date(
    refDate.getTime() - days * 24 * 60 * 60 * 1000,
  );
  const cutoffDateStr = getWibDateString(cutoffDate);

  const query = `
    SELECT
      order_id,
      ticket_id,
      date,
      create_time,
      site_id1_l1_assign AS site_id,
      kabupaten_kota_create_ticket AS city,
      order_status,
      sla_status,
      description_fault_sumptomps_create_ticket_description_fault_sym AS complaint_detail,
      description
    FROM "${schema}"."${table}"
    WHERE site_id1_l1_assign = ANY($1)
      AND date >= $2
      AND (order_status IS NULL OR LOWER(TRIM(order_status)) != 'completed')
    ORDER BY date DESC, create_time DESC
  `;

  try {
    const res = await queryDatabase(
      query,
      [siteIds, cutoffDateStr],
      options.customPool,
    );
    logger.info("Fetched recent active site tickets from database", {
      siteCount: siteIds.length,
      returnedRows: res?.rows?.length || 0,
      cutoffDate: cutoffDateStr,
    });
    return res?.rows || [];
  } catch (error) {
    logger.warn("Failed querying recent active site tickets from database", {
      error: error.message,
      siteCount: siteIds.length,
    });
    return [];
  }
}

/**
 * Mendeteksi keluhan repetitif berdasarkan site_id (>= threshold tiket aktif dalam seminggu kebelakang).
 * Menggabungkan tiket dari batch saat ini dan riwayat dari PostgreSQL (jika tersedia).
 *
 * @param {Array} tickets
 * @param {object} [options={}]
 * @returns {Promise<Array>}
 */
export async function detectSiteRepetitiveTickets(tickets, options = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return [];
  }

  const threshold = Number(options.threshold || DEFAULT_THRESHOLD);
  const lookbackDays = Number(options.days || DEFAULT_LOOKBACK_DAYS);
  const refDate = options.referenceDate
    ? new Date(options.referenceDate)
    : new Date();
  const cutoffDate = new Date(
    refDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
  );

  // 1. Filter tiket dari batch yang aktif dan berada dalam rentang lookback
  const validBatchTickets = [];
  const candidateSiteIds = new Set();

  for (const item of tickets) {
    const orderStatus =
      item.order_status ||
      item.row_raw?.order_status ||
      item.row_raw?.["Order Status"];
    if (!isTicketActive(orderStatus)) {
      continue;
    }

    const siteId = extractTicketSiteId(item);
    if (!siteId) {
      continue;
    }

    const ticketDate = parseDateTime(
      item.date ||
        item.create_time ||
        item.row_raw?.date ||
        item.row_raw?.Date ||
        item.row_raw?.["Create Time"],
    );
    if (ticketDate && ticketDate < cutoffDate) {
      continue;
    }

    validBatchTickets.push({
      ...item,
      site_id: siteId,
    });
    candidateSiteIds.add(siteId);
  }

  if (candidateSiteIds.size === 0) {
    return [];
  }

  // 2. Ambil riwayat tiket aktif dari DB untuk site terkait (jika DB terhubung)
  let dbTickets = [];
  if (!options.skipDb && isDatabaseConfigured()) {
    dbTickets = await fetchRecentActiveTicketsFromDb(
      Array.from(candidateSiteIds),
      {
        ...options,
        days: lookbackDays,
        referenceDate: refDate,
      },
    );
  }

  // 3. Gabungkan tiket (deduplikasi berdasarkan order_id)
  const ticketMap = new Map();

  // Masukkan dari DB terlebih dahulu
  for (const row of dbTickets) {
    const orderId = String(row.order_id || row.ticket_id || "").trim();
    if (orderId) {
      ticketMap.set(orderId, {
        order_id: orderId,
        ticket_id: row.ticket_id || orderId,
        site_id: row.site_id,
        city: row.city,
        order_status: row.order_status,
        sla_status: row.sla_status,
        create_time: row.create_time,
        date: row.date,
        complaint_detail: row.complaint_detail || row.description,
        source: "database",
      });
    }
  }

  // Timpa/gabungkan dengan tiket batch saat ini
  for (const t of validBatchTickets) {
    const orderId = String(t.order_id || t.ticket_id || "").trim();
    if (!orderId) continue;

    const existing = ticketMap.get(orderId);
    ticketMap.set(orderId, {
      ...existing,
      ...t,
      order_id: orderId,
      ticket_id: t.ticket_id || existing?.ticket_id || orderId,
      site_id: t.site_id,
      city: t.city || existing?.city,
      order_status:
        t.order_status ||
        t.row_raw?.order_status ||
        existing?.order_status ||
        "running",
      sla_status: t.sla_status || existing?.sla_status,
      create_time:
        t.create_time ||
        t.row_raw?.["Create Time"] ||
        existing?.create_time,
      date: t.date || t.row_raw?.Date || existing?.date,
      complaint_detail:
        extractComplaintDetail(t) !== "-"
          ? extractComplaintDetail(t)
          : existing?.complaint_detail || "-",
      source: "batch",
    });
  }

  // 4. Kelompokkan berdasarkan site_id
  const siteGroups = new Map();
  for (const item of ticketMap.values()) {
    const siteId = item.site_id;
    if (!siteId) continue;

    if (!siteGroups.has(siteId)) {
      siteGroups.set(siteId, []);
    }
    siteGroups.get(siteId).push(item);
  }

  // 5. Saring kelompok yang mencapai threshold (>= 2 tiket)
  const repetitiveGroups = [];

  for (const [siteId, groupTickets] of siteGroups.entries()) {
    if (groupTickets.length < threshold) {
      continue;
    }

    // Urutkan tiket terbaru di atas
    groupTickets.sort((a, b) => {
      const da = parseDateTime(a.create_time || a.date)?.getTime() || 0;
      const db = parseDateTime(b.create_time || b.date)?.getTime() || 0;
      return db - da;
    });

    // Cari metadata site (Nama Site, Kota, NOP) dari referensi
    const sample = groupTickets[0];
    const resolved = resolveSiteFromTicketRow(sample.row_raw || sample);

    const siteName = resolved?.site_name || sample.site_name || "-";
    const city =
      cleanTableValue(
        resolved?.city || sample.city || sample.kabupaten_kota_create_ticket,
      ) || "-";
    const nop =
      cleanTableValue(
        resolved?.departement_ns ||
          resolved?.cluster_area ||
          sample.departement_ns ||
          sample.cluster_area ||
          sample.assignment_group,
      ) || "-";

    repetitiveGroups.push({
      site_id: siteId,
      site_name: siteName,
      city,
      nop,
      count: groupTickets.length,
      tickets: groupTickets.map((t) => ({
        order_id: cleanTableValue(t.order_id || t.ticket_id),
        ticket_id: cleanTableValue(t.ticket_id || t.order_id),
        timestamp_text: formatTicketTimestamp(t),
        order_status: cleanTableValue(t.order_status || "-"),
        sla_status: cleanTableValue(t.sla_status || "-"),
        complaint_detail: extractComplaintDetail(t),
      })),
    });
  }

  // Urutkan grup berdasarkan jumlah komplain terbanyak, lalu alfabet site_id
  repetitiveGroups.sort(
    (a, b) => b.count - a.count || a.site_id.localeCompare(b.site_id),
  );

  logger.info("Detected site repetitive complaints", {
    siteCount: repetitiveGroups.length,
    threshold,
    lookbackDays,
  });

  return repetitiveGroups;
}

/**
 * Memformat pesan peringatan komplain repetitif site ID untuk dikirimkan ke grup pengirim.
 *
 * @param {Array} repetitiveGroups
 * @param {object} [options={}]
 * @returns {string|null}
 */
export function formatSiteRepetitiveAlertMessage(
  repetitiveGroups,
  options = {},
) {
  if (!Array.isArray(repetitiveGroups) || repetitiveGroups.length === 0) {
    return null;
  }

  const days = options.days || DEFAULT_LOOKBACK_DAYS;
  const lines = [
    `⚠️ *PERINGATAN: KOMPLAIN REPETITIF SITE ID (${days} HARI TERAKHIR)*`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `Terdeteksi *${repetitiveGroups.length} site* dengan komplain berulang (≥ 2 tiket aktif belum completed dalam ${days} hari terakhir):`,
    "",
  ];

  for (const group of repetitiveGroups) {
    const locInfo = [group.city, group.nop].filter((x) => x && x !== "-").join(" - ");
    const headerLoc = locInfo ? ` (${locInfo})` : "";

    lines.push(`📍 *Site ID: ${group.site_id}*${headerLoc}`);
    if (group.site_name && group.site_name !== "-") {
      lines.push(`• *Nama Site*: ${group.site_name}`);
    }
    lines.push(`• *Total Tiket Aktif*: *${group.count} tiket*`);
    lines.push("• *Rincian Tiket*:");

    group.tickets.forEach((t, idx) => {
      const statusText =
        t.order_status && t.order_status !== "-"
          ? ` | Status: \`${t.order_status}\``
          : "";
      const slaText =
        t.sla_status && t.sla_status !== "-"
          ? ` | SLA: ${t.sla_status}`
          : "";

      lines.push(
        `  ${idx + 1}. *${t.order_id}* (${t.timestamp_text})${statusText}${slaText}`,
      );
      lines.push(`     └ *Keluhan*: ${t.complaint_detail}`);
    });

    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(
    "ℹ️ *Catatan*: Pesan ini hanya dikirimkan ke grup pengirim sebagai monitoring komplain repetitif pada site yang sama.",
  );

  return lines.join("\n").trim();
}

/**
 * Fungsi pembungkus (facade) untuk mendeteksi dan langsung membuat pesan peringatan komplain repetitif site ID.
 *
 * @param {Array} tickets
 * @param {object} [options={}]
 * @returns {Promise<{text: string, siteCount: number, totalTickets: number, repetitiveGroups: Array}|null>}
 */
export async function generateSiteRepetitiveAlert(tickets, options = {}) {
  const repetitiveGroups = await detectSiteRepetitiveTickets(tickets, options);
  if (!repetitiveGroups || repetitiveGroups.length === 0) {
    return null;
  }

  const text = formatSiteRepetitiveAlertMessage(repetitiveGroups, options);
  if (!text) {
    return null;
  }

  const totalTickets = repetitiveGroups.reduce(
    (sum, g) => sum + (g.count || 0),
    0,
  );

  return {
    text,
    siteCount: repetitiveGroups.length,
    totalTickets,
    repetitiveGroups,
  };
}

