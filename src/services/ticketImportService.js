import readXlsxFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";
import JSZip from "jszip";

import {
  SITE_ID1_COLUMN,
  resolveCityFromTicketRow,
  resolveSiteFromTicketRow,
} from "./siteSearchService.js";
import {
  ASSIGNMENT_GROUP_COLUMN,
  CITY_COLUMN,
  getAssignmentType,
  searchPicFromTicketRow,
  normalizeAssignmentGroup,
} from "./picSearchService.js";
import { createLogger } from "../utils/logger.js";
import {
  addHours,
  formatDateTimeValue,
  formatResolveTarget,
  parseDateTime,
} from "../utils/dateTime.js";
import {
  cleanMultilineText,
  cleanTableValue,
  formatNameTag,
} from "../utils/text.js";
import { normalizeJid } from "../utils/jid.js";
import { getMentionContact } from "../config/appConfig.js";

const logger = createLogger("ticketImportService");

export const REQUIRED_COLUMNS = [
  "Order ID",
  "Ticket Id",
  "Create Time",
  "Business Status",
  ASSIGNMENT_GROUP_COLUMN,
  CITY_COLUMN,
  SITE_ID1_COLUMN,
  "Problem Analysis NSH",
  "CCH Suggestion(L1 Assign_cch_suggestion)",
  "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)",
  "Customer MSISDN(Create Ticket_customer_msisdn)",
];

const CCH_SUGGESTION_COLUMN = "CCH Suggestion(L1 Assign_cch_suggestion)";
const DESCRIPTION_COLUMN =
  "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)";
const PROBLEM_ANALYSIS_COLUMN = "Problem Analysis";
const REOPEN_NUMBER_COLUMN = "Reopen Number(Confirm Close)";
const REOPEN_FILLED_CHECK_COLUMNS = [
  "Assign Personal(L2 Assign)",
  "Resolution Categorization Tier 1",
  "Resolution Categorization Tier 3",
  "Resolution Categorization Tier 2(L1 Assign)",
  "Root Caused Tier 1(L2 Assign)",
  "Root Caused Tier 2(L2 Assign)",
  "Root Caused Tier 3(L2 Assign)",
  "Root Caused Tier 8(L2 Assign)",
  "Site ID(L2 Assign)",
];
const EXCEL_REPLY_HEADERS = [
  "Order ID",
  "Create Time",
  "Resolve Target 22 Hour",
  "SLA Status",
  "Business Status",
  "Assigment Group",
  "City",
  "Vendor",
  "PIC CCM",
  "Cluster Area",
  "Site ID",
  "PIC SQA",
  "PIC NOP",
];
const GROUP_OPENING_MESSAGE = [
  "Assalamualaikum,",
  "Semangat Pagi dan Semangat Sehat,",
  "Dear Bapak Manager dan Tim,",
  "Berikut kami infokan tiket Remedy Customer Complaint terupdate,",
  "Mohon dibantu untuk segera di follow up.",
  "",
  "link: https://10.62.7.112:31943/portal-web/portal/homepage.html",
  "",
  "Terimakasih 🙏🏻",
].join("\n");
const INDONESIAN_MONTHS_FULL = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];
const NOP_SHORT_NAMES = {
  ACEH: "ACEH",
  BINJAI: "BJI",
  MEDAN: "MEDAN",
  PEMATANGSIANTAR: "PMS",
  "RANTAU PRAPAT": "RAP",
  "PADANG SIDEMPUAN": "PSP",
};

// membaca beberapa byte awal file untuk memastikan isinya benar-benar XLSX zip, bukan sekadar nama file .xlsx.
function inspectWorkbookBuffer(buffer) {
  const bytes = [...buffer.subarray(0, 8)];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  const ascii = buffer
    .subarray(0, 16)
    .toString("utf8")
    .replace(/[^\x20-\x7E]/g, ".");

  return {
    hex,
    ascii,
    isXlsxZip: buffer[0] === 0x50 && buffer[1] === 0x4b,
    isLegacyXls: buffer[0] === 0xd0 && buffer[1] === 0xcf,
  };
}

// decode export web yang sering berupa HTML/CSV/TSV tetapi diberi ekstensi .xlsx.
function decodeTextWorkbook(buffer) {
  const head = buffer.subarray(0, 4);

  if (head[0] === 0xff && head[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }

  if (head[0] === 0xfe && head[1] === 0xff) {
    return buffer
      .swap16()
      .toString("utf16le")
      .replace(/^\uFEFF/, "");
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 200));
  const oddZeroBytes = sample.filter(
    (_, index) => index % 2 === 1 && sample[index] === 0,
  ).length;
  if (oddZeroBytes > sample.length / 4) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }

  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

// mengubah entity HTML umum supaya header/isi table export web terbaca normal.
function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}

// mengubah referensi cell Excel seperti BW12 menjadi index kolom zero-based.
function columnRefToIndex(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/i)?.[0] || "";
  return (
    [...letters.toUpperCase()].reduce(
      (index, letter) => index * 26 + (letter.charCodeAt(0) - 64),
      0,
    ) - 1
  );
}

// mengambil isi tag XML sederhana termasuk multiline agar cell inlineStr terbaca.
function getXmlTagContent(xml, tagName) {
  const match = xml.match(
    new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"),
  );
  return match ? match[1] : "";
}

// membaca shared strings XLSX jika workbook memakai t="s".
async function readSharedStrings(zip) {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) {
    return [];
  }

  const xml = await file.async("string");
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(
      (part) => decodeHtmlEntities(part[1]),
    );
    strings.push(parts.join(""));
  }

  return strings;
}

// membaca nilai cell dari XML XLSX untuk inlineStr, shared string, string biasa, dan angka.
function readXlsxCellValue(cellXml, sharedStrings) {
  const type = cellXml.match(/\bt="([^"]+)"/i)?.[1] || "";

  if (type === "inlineStr") {
    const inline = getXmlTagContent(cellXml, "is");
    const textParts = [...inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(
      (part) => decodeHtmlEntities(part[1]),
    );
    return textParts.join("");
  }

  const rawValue = decodeHtmlEntities(getXmlTagContent(cellXml, "v"));
  if (type === "s") {
    return sharedStrings[Number(rawValue)] ?? "";
  }

  if (type === "str") {
    return rawValue;
  }

  return rawValue;
}

// fallback parser XLSX berbasis JSZip untuk file export web yang tidak cocok dengan unzipper.
async function parseXlsxWithJsZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const workbookRels = zip.file("xl/_rels/workbook.xml.rels");
  const workbook = zip.file("xl/workbook.xml");
  let sheetPath = "xl/worksheets/sheet1.xml";

  if (workbook && workbookRels) {
    const workbookXml = await workbook.async("string");
    const relsXml = await workbookRels.async("string");
    const firstSheetRelId = workbookXml.match(
      /<sheet\b[^>]*\br:id="([^"]+)"/i,
    )?.[1];
    if (firstSheetRelId) {
      const target = relsXml.match(
        new RegExp(
          `<Relationship\\b[^>]*Id="${firstSheetRelId}"[^>]*Target="([^"]+)"`,
          "i",
        ),
      )?.[1];
      if (target) {
        sheetPath = target.startsWith("/")
          ? target.replace(/^\//, "")
          : `xl/${target.replace(/^\.\.\//, "")}`;
      }
    }
  }

  const sheetFile = zip.file(sheetPath) || zip.file("xl/worksheets/sheet1.xml");
  if (!sheetFile) {
    throw new Error("XLSX worksheet tidak ditemukan.");
  }

  const sharedStrings = await readSharedStrings(zip);
  const sheetXml = await sheetFile.async("string");
  const sheetRows = [];

  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(
      /<c\b[^>]*>([\s\S]*?)<\/c>/gi,
    )) {
      const cellXml = cellMatch[0];
      const cellRef = cellXml.match(/\br="([^"]+)"/i)?.[1] || "";
      const columnIndex = columnRefToIndex(cellRef);
      row[columnIndex >= 0 ? columnIndex : row.length] = readXlsxCellValue(
        cellXml,
        sharedStrings,
      );
    }

    if (row.some((cell) => String(cell ?? "").trim() !== "")) {
      sheetRows.push(row.map((cell) => cell ?? ""));
    }
  }

  return sheetRows;
}

// membersihkan isi cell HTML table menjadi teks biasa.
function cleanHtmlCell(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// parse HTML table hasil export web master data yang sering disimpan sebagai .xls/.xlsx.
function parseHtmlTableWorkbook(text) {
  if (!/<table[\s>]/i.test(text) || !/<tr[\s>]/i.test(text)) {
    return null;
  }

  const rows = [];
  const rowMatches = text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const cells = [];
    const cellMatches = rowMatch[1].matchAll(
      /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi,
    );
    for (const cellMatch of cellMatches) {
      cells.push(cleanHtmlCell(cellMatch[1]));
    }

    if (cells.some((cell) => cell !== "")) {
      rows.push(cells);
    }
  }

  return rows.length > 0 ? rows : null;
}

// parse CSV/TSV sederhana dengan dukungan quote agar export text dari web tetap bisa dibaca.
function parseDelimitedWorkbook(text) {
  const delimiter = text.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some((value) => value !== "")) {
    rows.push(row);
  }

  return rows.length > 0 ? rows : null;
}

// fallback parser untuk export web non-XLSX yang isinya masih berupa table/text.
function parseWebExportWorkbook(buffer) {
  const text = decodeTextWorkbook(buffer);
  const normalized = text.trim();

  if (!normalized) {
    return null;
  }

  return (
    parseHtmlTableWorkbook(normalized) || parseDelimitedWorkbook(normalized)
  );
}

// mengubah array baris/cell menjadi object row berbasis header.
function rowsToObjects(sheetRows) {
  if (sheetRows.length === 0) {
    throw new Error("Workbook does not contain any sheet");
  }

  const headers = sheetRows[0].map((value) => String(value ?? "").trim());

  return sheetRows.slice(1).map((row) => {
    const item = {};
    headers.forEach((header, index) => {
      if (!header) {
        return;
      }

      item[header] = row[index] ?? "";
    });

    return item;
  });
}

// membuat hasil gagal yang bisa diformat sebagai balasan WhatsApp tanpa melempar error mentah ke user.
function createInvalidWorkbookResult({
  totalRows = 0,
  reason,
  detail,
  signature,
}) {
  return {
    ok: false,
    reason,
    detail,
    signature,
    total_rows: totalRows,
    valid_tickets: [],
    skipped_tickets: [],
    grouped_tickets: {},
    processing_log: [],
  };
}

// memastikan Excel input punya semua kolom wajib sebelum proses filter dimulai.
function validateHeaders(headers) {
  logger.info("Validating required Excel headers", {
    headerCount: headers.length,
  });
  const missing = REQUIRED_COLUMNS.filter(
    (column) => !headers.includes(column),
  );
  if (missing.length > 0) {
    logger.warn("Required Excel headers missing", { missing });
  }
  return missing;
}

// membaca sheet pertama file .xlsx dan mengubah setiap baris menjadi object berbasis header Excel.
async function parseWorkbook(buffer) {
  try {
    logger.info("Parsing Excel workbook", { bytes: buffer.length });
    const signature = inspectWorkbookBuffer(buffer);
    logger.info("Excel workbook signature inspected", signature);

    if (signature.isXlsxZip) {
      let sheetRows;
      try {
        sheetRows = await readXlsxFile(buffer);
      } catch (error) {
        logger.warn("Default XLSX parser failed, trying JSZip fallback", {
          message: error.message,
        });
        sheetRows = await parseXlsxWithJsZip(buffer);
      }
      const rows = rowsToObjects(sheetRows);
      logger.info("Excel workbook parsed", {
        rows: rows.length,
        columns: Object.keys(rows[0] || {}).length,
      });
      return rows;
    }

    const webExportRows = parseWebExportWorkbook(buffer);
    if (webExportRows) {
      const rows = rowsToObjects(webExportRows);
      logger.info("Web export workbook parsed", {
        rows: rows.length,
        columns: Object.keys(rows[0] || {}).length,
        signature,
      });
      return rows;
    }

    const detail = signature.isLegacyXls
      ? "File terlihat seperti Excel lama .xls binary. Buka file lalu Save As ke Excel Workbook (*.xlsx)."
      : "File bukan .xlsx valid dan tidak dikenali sebagai HTML/CSV/TSV export.";
    const error = new Error(detail);
    error.code = "INVALID_XLSX_SIGNATURE";
    error.signature = signature;
    throw error;
  } catch (error) {
    logger.error("Failed to parse Excel workbook", error);
    throw error;
  }
}

// menghitung target penyelesaian 22 jam dan status IN SLA / OUT SLA.
function calculateSla(createTime, now = new Date()) {
  logger.debug("Calculating SLA", { createTime });
  const createdAt = parseDateTime(createTime);
  if (!createdAt) {
    return {
      sla_status: "UNKNOWN",
      resolve_target_22h: null,
    };
  }

  const resolveTarget = addHours(createdAt, 22);

  return {
    sla_status: now <= resolveTarget ? "IN SLA" : "OUT SLA",
    resolve_target_22h: resolveTarget,
  };
}

// mendeteksi CCH Suggestion kosong/null agar bisa fallback ke Problem Analysis NSH.
function isEmptyCchSuggestion(value) {
  const text = String(value ?? "").trim();
  const normalized = text.toLowerCase().replace(/\s+/g, " ");

  return (
    !text ||
    normalized === "null" ||
    (normalized.includes("no matched data is found") &&
      normalized.includes("suggestion: null") &&
      normalized.includes("other: null"))
  );
}

// memilih teks analisis untuk pesan, prioritas CCH Suggestion lalu fallback Problem Analysis NSH.
function getAnalysisText(row) {
  const cchSuggestion = row[CCH_SUGGESTION_COLUMN];
  if (!isEmptyCchSuggestion(cchSuggestion)) {
    logger.debug("Using CCH Suggestion as analysis text", {
      orderId: row["Order ID"],
    });
    return cleanMultilineText(cchSuggestion);
  }

  logger.debug("Using Problem Analysis NSH as analysis fallback", {
    orderId: row["Order ID"],
  });
  return cleanMultilineText(row["Problem Analysis NSH"]);
}

// mendeteksi nilai cell benar-benar terisi untuk rule ReOpen; null/string kosong/tanda "-" dianggap kosong.
function isFilledCell(value) {
  const text = String(value ?? "").trim();
  return Boolean(text && text !== "-");
}

// mengecek apakah tiket ReOpen sudah punya data L2/resolution/root cause/site L2 sehingga perlu format khusus.
function resolveReopenMessageRule(row) {
  const businessStatus = String(row["Business Status"] || "")
    .trim()
    .toLowerCase();
  const filledColumns = REOPEN_FILLED_CHECK_COLUMNS.filter((column) =>
    isFilledCell(row[column]),
  );
  const enabled = businessStatus === "reopen" && filledColumns.length > 0;

  logger.info("Resolved ReOpen message rule", {
    orderId: row["Order ID"],
    businessStatus: row["Business Status"],
    enabled,
    filledColumns,
    reopenNumber: row[REOPEN_NUMBER_COLUMN],
  });

  return {
    enabled,
    reopen_number: cleanTableValue(row[REOPEN_NUMBER_COLUMN]),
    filled_columns: filledColumns,
  };
}

// menggabungkan data Excel, hasil search PIC, hasil search site, dan SLA menjadi object tiket final.
function normalizeTicket(row, picResult, siteResolution) {
  logger.info("Normalizing ticket row", {
    orderId: row["Order ID"],
    ticketId: row["Ticket Id"],
  });
  const assignmentGroup = normalizeAssignmentGroup(
    row[ASSIGNMENT_GROUP_COLUMN],
  );
  const assignmentType = getAssignmentType(assignmentGroup);
  const sla = calculateSla(row["Create Time"]);
  const isSqa = assignmentType === "SQA";
  const isNop = assignmentType === "NOP";
  const reopenRule = resolveReopenMessageRule(row);

  const ticket = {
    order_id: row["Order ID"],
    ticket_id: row["Ticket Id"],
    create_time: row["Create Time"],
    business_status: row["Business Status"],
    assignment_group: assignmentGroup,
    assignment_type: assignmentType,
    sla_status: sla.sla_status,
    resolve_target_22h: sla.resolve_target_22h,
    resolve_target_22h_text: formatResolveTarget(sla.resolve_target_22h),
    city: picResult.city,
    nsa: picResult.nsa,
    vendor: siteResolution.ok ? siteResolution.vendor : "",
    cluster_area: siteResolution.ok ? siteResolution.cluster_area : "",
    site_id: siteResolution.site_id || "",
    site_source: siteResolution.source || "",
    ccm_handling: isSqa ? picResult.ccm_handling : "",
    city_source: row.__city_source || "city_column",
    site_cover: row.__site_cover || null,
    pic: picResult.pic,
    pic_sqa: isSqa ? picResult.pic_sqa : "",
    pic_nop: isNop ? picResult.pic_nop : "",
    msisdn: row["Customer MSISDN(Create Ticket_customer_msisdn)"],
    notes: cleanMultilineText(row[DESCRIPTION_COLUMN]),
    analysis_text: getAnalysisText(row),
    problem_analysis: cleanMultilineText(row[PROBLEM_ANALYSIS_COLUMN]),
    use_reopen_message_format: reopenRule.enabled,
    reopen_number: reopenRule.reopen_number,
    reopen_filled_columns: reopenRule.filled_columns,
  };

  logger.info("Ticket normalized", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    city: ticket.city,
    siteId: ticket.site_id,
    slaStatus: ticket.sla_status,
    pic: ticket.pic,
    useReopenMessageFormat: ticket.use_reopen_message_format,
  });

  return ticket;
}

// mengambil identifier tiket paling berguna untuk report, prioritas Order ID.
function getTicketRef(row) {
  return (
    row.order_id || row["Order ID"] || row.ticket_id || row["Ticket Id"] || "-"
  );
}

// membuat ringkasan jumlah tiket berdasarkan alasan skip, PIC, atau assignment type.
function countBy(items, keyFn) {
  logger.debug("Counting grouped items", { total: items.length });
  return items.reduce((counts, item) => {
    const key = keyFn(item) || "-";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

// flow utama filterisasi Excel dari validasi, assignment, city/site, PIC, SLA, sampai pemisahan valid/skip.
export async function processTicketExcel(buffer) {
  logger.info("Starting ticket Excel processing");
  let rows;
  try {
    rows = await parseWorkbook(buffer);
  } catch (error) {
    if (
      error.code === "INVALID_XLSX_SIGNATURE" ||
      String(error.message || "").includes("invalid signature")
    ) {
      return createInvalidWorkbookResult({
        reason: "INVALID_EXCEL_FILE",
        detail:
          error.code === "INVALID_XLSX_SIGNATURE"
            ? error.message
            : "File tidak bisa dibaca sebagai .xlsx valid atau export web HTML/CSV/TSV.",
        signature: error.signature || inspectWorkbookBuffer(buffer),
      });
    }

    throw error;
  }
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const missingColumns = validateHeaders(headers);

  if (missingColumns.length > 0) {
    logger.warn(
      "Stopping ticket Excel processing because required headers are missing",
      {
        missingColumns,
      },
    );
    return {
      ok: false,
      reason: "MISSING_COLUMNS",
      missing_columns: missingColumns,
      total_rows: rows.length,
      valid_tickets: [],
      skipped_tickets: [],
      grouped_tickets: {},
      processing_log: [],
    };
  }

  const validTickets = [];
  const skippedTickets = [];
  const processingLog = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    logger.info("Processing Excel row", {
      rowNumber,
      orderId: row["Order ID"],
      ticketId: row["Ticket Id"],
    });
    const assignmentGroup = normalizeAssignmentGroup(
      row[ASSIGNMENT_GROUP_COLUMN],
    );
    const assignmentType = getAssignmentType(assignmentGroup);
    const cityResolution = resolveCityFromTicketRow(row);
    const siteResolution = resolveSiteFromTicketRow(row);

    if (assignmentType === "UNKNOWN") {
      const skipped = {
        reason: "ASSIGNMENT_GROUP_NOT_SUPPORTED",
        row_number: rowNumber,
        order_id: row["Order ID"],
        ticket_id: row["Ticket Id"],
        city: row[CITY_COLUMN],
        assignment_group: assignmentGroup,
      };
      skippedTickets.push(skipped);
      logger.warn("Row skipped: unsupported assignment group", skipped);
      processingLog.push({
        status: "SKIPPED",
        ...skipped,
      });
      continue;
    }

    if (!cityResolution.ok) {
      const skipped = {
        reason: cityResolution.reason,
        row_number: rowNumber,
        order_id: row["Order ID"],
        ticket_id: row["Ticket Id"],
        city: row[CITY_COLUMN],
        assignment_group: assignmentGroup,
        site_cover: cityResolution.site_id,
        site_id: siteResolution.site_id,
      };
      skippedTickets.push(skipped);
      logger.warn("Row skipped: city resolution failed", skipped);
      processingLog.push({
        status: "SKIPPED",
        ...skipped,
      });
      continue;
    }

    const resolvedRow = {
      ...row,
      [CITY_COLUMN]: cityResolution.city,
      __city_source: cityResolution.source,
      __site_cover: cityResolution.site_id,
    };

    const picResult = searchPicFromTicketRow(resolvedRow);
    if (!picResult.ok) {
      const skipped = {
        reason: picResult.reason,
        row_number: rowNumber,
        order_id: row["Order ID"],
        ticket_id: row["Ticket Id"],
        city: cityResolution.city,
        assignment_group: assignmentGroup,
        city_source: cityResolution.source,
        site_cover: cityResolution.site_id,
        site_id: siteResolution.site_id,
      };
      skippedTickets.push(skipped);
      logger.warn("Row skipped: PIC search failed", skipped);
      processingLog.push({
        status: "SKIPPED",
        ...skipped,
      });
      continue;
    }

    const ticket = normalizeTicket(resolvedRow, picResult, siteResolution);
    ticket.row_number = rowNumber;
    validTickets.push(ticket);
    logger.info("Row marked valid", {
      rowNumber,
      orderId: ticket.order_id,
      assignmentType: ticket.assignment_type,
      pic: ticket.pic,
    });
    processingLog.push({
      status: "VALID",
      row_number: rowNumber,
      order_id: ticket.order_id,
      ticket_id: ticket.ticket_id,
      city: ticket.city,
      assignment_group: ticket.assignment_group,
      assignment_type: ticket.assignment_type,
      sla_status: ticket.sla_status,
      pic: ticket.pic,
      ccm_handling: ticket.ccm_handling,
      nsa: ticket.nsa,
      city_source: ticket.city_source,
      site_cover: ticket.site_cover,
      site_id: ticket.site_id,
      vendor: ticket.vendor,
      cluster_area: ticket.cluster_area,
      use_reopen_message_format: ticket.use_reopen_message_format,
      reopen_number: ticket.reopen_number,
      reopen_filled_columns: ticket.reopen_filled_columns,
    });
  }

  const groupedTickets = validTickets.reduce((groups, ticket) => {
    const key = `${ticket.assignment_type}:${ticket.pic}`;
    groups[key] ||= [];
    groups[key].push(ticket);
    return groups;
  }, {});

  const result = {
    ok: true,
    total_rows: rows.length,
    valid_count: validTickets.length,
    skipped_count: skippedTickets.length,
    valid_tickets: validTickets,
    skipped_tickets: skippedTickets,
    grouped_tickets: groupedTickets,
    processing_log: processingLog,
    skipped_by_reason: countBy(skippedTickets, (ticket) => ticket.reason),
    valid_by_pic: countBy(validTickets, (ticket) => ticket.pic),
    valid_by_assignment_type: countBy(
      validTickets,
      (ticket) => ticket.assignment_type,
    ),
  };

  logger.info("Ticket Excel processing finished", {
    total: result.total_rows,
    valid: result.valid_count,
    skipped: result.skipped_count,
  });

  return result;
}

// membuat pesan ringkas jumlah total, valid, dan dilewati untuk dikirim ke pengirim file.
export function formatImportSummary(result) {
  logger.info("Formatting import summary", { ok: result.ok });
  if (!result.ok && result.reason === "INVALID_EXCEL_FILE") {
    return [
      "File Excel tidak valid.",
      "",
      "Bot sudah mencoba membaca sebagai XLSX normal, XLSX export web, HTML, CSV, dan TSV.",
      result.detail ? `Detail: ${result.detail}` : "",
      result.signature?.hex ? `Signature: ${result.signature.hex}` : "",
      "",
      "Solusi:",
      "- Buka file di Microsoft Excel/WPS/LibreOffice.",
      "- Save As ke format Excel Workbook (*.xlsx).",
      "- Kirim ulang file hasil Save As tersebut.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!result.ok && result.reason === "MISSING_COLUMNS") {
    return [
      "File tidak valid.",
      "",
      "Kolom wajib berikut tidak ditemukan:",
      ...result.missing_columns.map((column) => `- ${column}`),
    ].join("\n");
  }

  return [
    "Import tiket selesai.",
    "",
    `Total row: ${result.total_rows}`,
    `Tiket valid: ${result.valid_count}`,
    `Tiket dilewati: ${result.skipped_count}`,
  ].join("\n");
}

// membuat report detail alasan tiket valid/dilewati agar proses filter bisa diaudit dari WhatsApp.
export function formatProcessingReport(result) {
  logger.info("Formatting processing report", { ok: result.ok });
  if (!result.ok) {
    return "";
  }

  const lines = [
    "Report proses import",
    "",
    "Valid per assignment:",
    ...Object.entries(result.valid_by_assignment_type).map(
      ([key, count]) => `- ${key}: ${count}`,
    ),
    "",
    "Valid per PIC:",
    ...Object.entries(result.valid_by_pic).map(
      ([key, count]) => `- ${key}: ${count}`,
    ),
  ];

  if (result.skipped_tickets.length > 0) {
    lines.push(
      "",
      "Dilewati per alasan:",
      ...Object.entries(result.skipped_by_reason).map(
        ([key, count]) => `- ${key}: ${count}`,
      ),
      "",
      "Detail dilewati:",
      ...result.skipped_tickets.map(
        (ticket) =>
          `- Order ID ${getTicketRef(ticket)} | ${ticket.reason} | ${ticket.city || "-"} | ${ticket.assignment_group || "-"}${ticket.site_id ? ` | Site ID: ${ticket.site_id}` : ""}`,
      ),
    );
  }

  if (result.valid_tickets.length > 0) {
    lines.push(
      "",
      "Detail valid:",
      ...result.valid_tickets.map(
        (ticket) =>
          `- Order ID ${getTicketRef(ticket)} | ${ticket.assignment_type} | ${ticket.city} | ${ticket.sla_status} | PIC: ${ticket.pic}${ticket.site_id ? ` | Site ID: ${ticket.site_id}` : ""}`,
      ),
    );
  }

  return lines.join("\n");
}

// mengambil user part JID untuk token @mention yang dikenali WhatsApp, contoh 628xx@s.whatsapp.net -> @628xx.
function getMentionTokenFromJid(jid) {
  const normalizedJid = normalizeJid(jid);
  const userPart = normalizedJid.split("@")[0];

  return userPart ? `@${userPart}` : "";
}

// mengambil label/JID mention dari config; fallback ke label teks biasa jika config belum lengkap.
function resolveMentionTag(name, fallbackSuffix = "") {
  const contact = getMentionContact(name);
  const fallbackTag = formatNameTag(name, fallbackSuffix);
  const label = cleanTableValue(contact?.label || fallbackTag);
  const jid = normalizeJid(contact?.jid);
  const mentionToken = getMentionTokenFromJid(jid);

  if (label === "-") {
    return {
      text: "",
      jid: null,
      label: "",
      mention_token: "",
    };
  }

  if (mentionToken) {
    logger.info("Mention tag resolved with JID token", {
      name,
      jid,
      label,
      mentionToken,
    });
    return {
      text: mentionToken,
      jid,
      label,
      mention_token: mentionToken,
    };
  }

  logger.warn("Mention tag resolved without JID, output will be plain text", {
    name,
    label,
  });

  return {
    text: `@${label.replace(/^@+/, "")}`,
    jid: null,
    label,
    mention_token: "",
  };
}

// menghapus JID kosong/duplikat agar payload mentions bersih.
function uniqueMentionJids(items) {
  return [...new Set(items.map((item) => item?.jid).filter(Boolean))];
}

// menghitung total tiket, IN SLA, dan OUT SLA untuk reminder per grup tujuan.
function summarizeSla(tickets) {
  return tickets.reduce(
    (summary, ticket) => {
      summary.total += 1;
      if (ticket.sla_status === "IN SLA") {
        summary.inSla += 1;
      }
      if (ticket.sla_status === "OUT SLA") {
        summary.outSla += 1;
      }
      return summary;
    },
    { total: 0, inSla: 0, outSla: 0 },
  );
}

// mengambil tiket yang punya informasi ReOpen untuk ditampilkan pada tabel remark reminder.
function getReopenReminderTickets(tickets) {
  return tickets.filter(
    (ticket) =>
      cleanTableValue(ticket.reopen_number) !== "-" ||
      cleanMultilineText(ticket.problem_analysis),
  );
}

// membuat nama pendek NOP seperti BJI dari cluster area/NOP asal tiket.
function getNopReminderName(tickets) {
  const firstTicket = tickets[0] || {};
  const source = cleanTableValue(
    firstTicket.cluster_area || firstTicket.nsa || firstTicket.assignment_group,
  )
    .replace(/^NOP\s+/i, "")
    .toUpperCase();

  return NOP_SHORT_NAMES[source] || source || "NOP";
}

// mengambil teks remark Problem Analysis untuk tabel reminder.
function getpreviousProblemAnalysis(ticket) {
  return cleanTableValue(cleanMultilineText(ticket.problem_analysis));
}

// mengambil nilai Count ReOpen dari kolom Reopen Number(Confirm Close).
function getReopenCount(ticket) {
  return cleanTableValue(ticket.reopen_number);
}

// membuat teks reminder untuk grup SQA sebelum detail tiket dikirim.
function formatSqaReminderMessage(tickets) {
  const summary = summarizeSla(tickets);
  const detailTickets = getReopenReminderTickets(tickets);
  const lines = [
    "Remind Ticket CX Open:",
    "",
    "*Group | Total Ticket | In SLA | Out SLA*",
    `*SQA | ${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
    "",
    "Wilayah | Nomor Ticket | SITE ID | Count ReOpen | Remark ReOpen",
    ...detailTickets.map(
      (ticket) =>
        `${cleanTableValue(ticket.nsa || ticket.city)} | ${cleanTableValue(
          ticket.order_id,
        )} | ${cleanTableValue(ticket.site_id)} | ${getReopenCount(
          ticket,
        )} | ${getpreviousProblemAnalysis(ticket)}`,
    ),
  ];

  return lines.join("\n");
}

// membuat teks reminder untuk grup NOP sebelum detail tiket dikirim.
function formatNopReminderMessage(tickets) {
  const summary = summarizeSla(tickets);
  const nopName = getNopReminderName(tickets);
  const detailTickets = getReopenReminderTickets(tickets);
  const mentionTags = detailTickets.map((ticket) =>
    resolveMentionTag(ticket.pic_nop),
  );
  const lines = [
    "Remind ticket CX Open :",
    "",
    "*NOP | Total Ticket | In SLA | Out SLA*",
    `*${nopName} | ${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
    "",
    "PIC NOP | Nomor Ticket | Site ID | Count ReOpen | Remark ReOpen",
    ...detailTickets.map((ticket, index) => {
      const tag = mentionTags[index];
      return `${tag?.text || "-"} | ${cleanTableValue(ticket.order_id)} | ${cleanTableValue(
        ticket.site_id,
      )} | ${getReopenCount(ticket)} | ${getpreviousProblemAnalysis(ticket)}`;
    }),
  ];

  return {
    text: lines.join("\n"),
    mentions: uniqueMentionJids(mentionTags),
  };
}

// pesan salam yang dikirim ke grup tujuan sebelum Excel, reminder, dan detail tiket.
export function formatTargetGroupOpeningMessage() {
  logger.info("Formatting target group opening message");
  return GROUP_OPENING_MESSAGE;
}

// nama file Excel update harian, contoh: Update Ticket 20 Juli Pagi.xlsx.
export function formatUpdateTicketFileName(now = new Date()) {
  const period =
    now.getHours() < 11
      ? "Pagi"
      : now.getHours() < 15
        ? "Siang"
        : now.getHours() < 18
          ? "Sore"
          : "Malam";
  const fileName = `Update Ticket ${now.getDate()} ${
    INDONESIAN_MONTHS_FULL[now.getMonth()]
  } ${period}.xlsx`;

  logger.info("Formatted update ticket file name", { fileName });
  return fileName;
}

// membuat payload reminder berdasarkan assignment grup target.
export function formatReminderMessagePayload(tickets) {
  const assignmentType = tickets[0]?.assignment_type;
  logger.info("Formatting reminder message payload", {
    assignmentType,
    tickets: tickets.length,
  });

  if (assignmentType === "SQA") {
    return {
      text: formatSqaReminderMessage(tickets),
      mentions: [],
    };
  }

  return formatNopReminderMessage(tickets);
}

// membuat format khusus untuk Ticket Re-Open yang sudah memiliki data L2/resolution/root cause/site L2.
function formatReopenEscalationText(ticket, { ccmTag, sqaTag, nopTag }) {
  const isSqa = ticket.assignment_type === "SQA";
  const reopenNumber = cleanTableValue(ticket.reopen_number);
  const reopenLine =
    reopenNumber === "-"
      ? "*Ticket Re-Open*"
      : `*Ticket Re-Open (${reopenNumber} X)*`;
  const problemAnalysisRemark = cleanMultilineText(ticket.problem_analysis);
  const remarkLines = problemAnalysisRemark
    ? ["_Remark Problem Analysis:_", problemAnalysisRemark]
    : [];

  logger.info("Formatting ReOpen escalation text", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    reopenNumber,
    hasProblemAnalysisRemark: Boolean(problemAnalysisRemark),
    filledColumns: ticket.reopen_filled_columns,
  });

  if (isSqa) {
    return [
      `Mohon dibantu pengecekannya kembali ya bang ${ccmTag.text || "-"}`,
      `*${ticket.order_id || "-"}*`,
      `CC bang ${sqaTag.text || "-"}`,
      "",
      reopenLine,
      ...remarkLines,
      `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
    ].join("\n");
  }

  return [
    `Mohon dibantu pengecekannya kembali ya bang ${nopTag.text || "-"}`,
    `*${ticket.order_id || "-"}*`,
    "",
    reopenLine,
    ...remarkLines,
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
  ].join("\n");
}

// membuat teks pesan eskalasi dan daftar JID mention yang dikirim ke Baileys.
export function formatEscalationMessagePayload(ticket) {
  logger.info("Formatting escalation message", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
  });
  const ccmTag = resolveMentionTag(ticket.ccm_handling, "CCM");
  const sqaTag = resolveMentionTag(ticket.pic_sqa, "PIC SQA Telkomsel");
  const nopTag = resolveMentionTag(ticket.pic_nop);
  const isSqa = ticket.assignment_type === "SQA";

  if (ticket.use_reopen_message_format) {
    const mentions = uniqueMentionJids(isSqa ? [ccmTag, sqaTag] : [nopTag]);
    const text = formatReopenEscalationText(ticket, { ccmTag, sqaTag, nopTag });

    logger.info("ReOpen escalation message mention payload created", {
      orderId: ticket.order_id,
      mentionDetails: isSqa ? [ccmTag, sqaTag] : [nopTag],
      mentions,
    });

    return {
      text,
      mentions,
    };
  }

  const intro = isSqa
    ? [
        `Mohon dibantu bang ${ccmTag.text || "-"}`,
        ticket.order_id || "-",
        `CC bang ${sqaTag.text || "-"}`,
      ]
    : [`Mohon dibantu bang ${nopTag.text || "-"}`, ticket.order_id || "-"];
  const repeatedOrderId = isSqa ? [ticket.order_id || "-", ""] : [];

  const text = [
    ...intro,
    "",
    ...repeatedOrderId,
    ticket.notes || "-",
    "",
    "========",
    "",
    ticket.analysis_text || "-",
    "",
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
  ].join("\n");

  const mentions = uniqueMentionJids(isSqa ? [ccmTag, sqaTag] : [nopTag]);
  logger.info("Escalation message mention payload created", {
    orderId: ticket.order_id,
    mentionDetails: isSqa ? [ccmTag, sqaTag] : [nopTag],
    mentions,
  });

  return {
    text,
    mentions,
  };
}

// membuat format pesan eskalasi final untuk SQA/NOP berdasarkan PIC dan konten notes/analisis.
export function formatEscalationMessage(ticket) {
  return formatEscalationMessagePayload(ticket).text;
}

// membungkus nilai menjadi cell untuk library write-excel-file.
function excelCell(value) {
  return {
    type: String,
    value: cleanTableValue(value),
  };
}

// membuat file Excel balasan berisi tiket valid dengan header hasil filter yang disepakati.
export async function createFilteredTicketsExcel(result) {
  logger.info("Creating filtered tickets Excel", {
    validTickets: result.valid_tickets.length,
  });
  const rows = [
    EXCEL_REPLY_HEADERS.map((header) => ({
      type: String,
      value: header,
      fontWeight: "bold",
    })),
    ...result.valid_tickets.map((ticket) =>
      [
        ticket.order_id,
        formatDateTimeValue(
          ticket.create_time,
          cleanTableValue(ticket.create_time),
        ),
        ticket.resolve_target_22h_text,
        ticket.sla_status,
        ticket.business_status,
        ticket.assignment_group,
        ticket.city,
        ticket.vendor,
        ticket.ccm_handling,
        ticket.cluster_area,
        ticket.site_id,
        ticket.pic_sqa,
        ticket.pic_nop,
      ].map(excelCell),
    ),
  ];

  try {
    const buffer = await writeXlsxFile(rows, {
      buffer: true,
      sheet: "Filtered Tickets",
      columns: EXCEL_REPLY_HEADERS.map(() => ({ width: 24 })),
    });
    logger.info("Filtered tickets Excel created", { bytes: buffer.length });
    return buffer;
  } catch (error) {
    logger.error("Failed to create filtered tickets Excel", error);
    throw error;
  }
}
