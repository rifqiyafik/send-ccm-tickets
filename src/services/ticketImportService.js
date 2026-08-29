import readXlsxFile from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";
import JSZip from "jszip";

import {
  SITE_ID1_COLUMN,
  extractSiteCover,
  resolveCityFromTicketRow,
  resolveSiteFromTicketRow,
} from "./siteSearchService.js";
import { resolveTsSiteVisit } from "./siteVisitService.js";
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
import { createCodeBlock, formatAsciiTable } from "../utils/asciiTable.js";
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
const PROBLEM_START_TIME_COLUMNS = [
  "Problem Start Time",
  "Problem Start Time(Create Ticket_problem_start_time)",
];
const CUSTOMER_INTERACTION_DATE_COLUMNS = [
  "Customer Interaction Date",
  "Customer Interaction Date(Create Ticket)",
  "Customer Interaction Date(Create Ticket_customer_interaction_date)",
];
const CUSTOMER_MSISDN_COLUMNS = [
  "Customer MSISDN(Create Ticket_customer_msisdn)",
  "Customer MSISDN",
];
const VILLAGE_COLUMNS = [
  "Desa/Kelurahan(Create Ticket)",
  "Desa/Kelurahan",
  "Kelurahan(Create Ticket)",
  "Kelurahan",
];
const DISTRICT_COLUMNS = [
  "kecamatan(Create Ticket)",
  "Kecamatan(Create Ticket)",
  "kecamatan",
  "Kecamatan",
];
const COMPLAINT_DESCRIPTION_COLUMNS = [
  "Description",
  "Description(Create Ticket_description)",
];
const PROBLEM_ANALYSIS_COLUMN = "Problem Analysis";
const PROBLEM_ANALYSIS_NSH_COLUMN = "Problem Analysis NSH";
const RESOLUTION_L2_ASSIGN_COLUMNS = [
  "Resolution(L2 Assign)",
  "Resolution (L2 Assign)",
  "Resolution",
];
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

function normalizeColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function getFirstRowValue(row, columns) {
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      const value = row[column];
      if (cleanTableValue(value) !== "-") {
        return value;
      }
    }
  }

  const normalizedColumns = new Set(columns.map(normalizeColumnName));
  for (const [header, value] of Object.entries(row)) {
    if (
      normalizedColumns.has(normalizeColumnName(header)) &&
      cleanTableValue(value) !== "-"
    ) {
      return value;
    }
  }

  return "";
}

function createFallbackResolution(field, source, missingFields = []) {
  return {
    field,
    source,
    missing_fields: missingFields,
  };
}

const CCH_SUGGESTION_COLUMNS = [
  "CCH Suggestion(L1 Assign_cch_suggestion)",
  "cch_suggestion_2(L1 Assign)",
  "cch_suggestion_3(L1 Assign)",
  "CCH Suggestion 2(L1 Assign)",
  "CCH Suggestion 3(L1 Assign)",
];

function hasReadableSiteOrCell(textInput) {
  const text = String(textInput ?? "");
  if (!text) return false;
  if (/#?\s*site\s*(?:cover|id|name)\s*[:=-]/i.test(text)) return true;
  if (/\b[EN]_[A-Z]{2,5}\d{2,5}\w*\b/i.test(text)) return true;
  if (/the site name is\s+[A-Z0-9_-]+/i.test(text)) return true;
  return false;
}

// mendeteksi CCH Suggestion kosong/null/invalid agar bisa fallback ke Problem Analysis NSH.
function isInvalidAnalysisText(value) {
  const text = String(value ?? "").trim();
  const normalized = text.toLowerCase().replace(/\s+/g, " ");

  return (
    !text ||
    text === "-" ||
    normalized === "null" ||
    (normalized.includes("no matched data is found") &&
      normalized.includes("suggestion: null") &&
      normalized.includes("other: null")) ||
    (normalized.includes("cause: the root cause is not found") &&
      normalized.includes("suggestion: null") &&
      normalized.includes("other: null"))
  );
}

// memilih teks analisis untuk pesan, prioritas CCH Suggestion (1/2/3) yang valid & informatif, fallback Problem Analysis NSH.
function getAnalysisText(row) {
  const candidates = [];

  for (const col of CCH_SUGGESTION_COLUMNS) {
    if (
      Object.prototype.hasOwnProperty.call(row, col) ||
      row[col] !== undefined
    ) {
      const val = row[col];
      if (!isInvalidAnalysisText(val)) {
        candidates.push({
          source: col,
          text: cleanMultilineText(val),
          hasSite: hasReadableSiteOrCell(val),
        });
      }
    }
  }

  const nshText = row[PROBLEM_ANALYSIS_NSH_COLUMN];
  if (!isInvalidAnalysisText(nshText)) {
    candidates.push({
      source: PROBLEM_ANALYSIS_NSH_COLUMN,
      text: cleanMultilineText(nshText),
      hasSite: hasReadableSiteOrCell(nshText),
    });
  }

  if (candidates.length === 0) {
    logger.warn("Analysis text fallback is unavailable", {
      orderId: row["Order ID"],
    });
    return {
      text: "",
      fallback: null,
    };
  }

  // Utamakan kandidat yang memiliki nama Site/Cell yang terbaca dibanding hanya angka CGI opaque
  const preferred = candidates.find((c) => c.hasSite) || candidates[0];

  const isPrimary = preferred.source === CCH_SUGGESTION_COLUMN;
  if (isPrimary) {
    logger.debug("Using CCH Suggestion as analysis text", {
      orderId: row["Order ID"],
    });
    return {
      text: preferred.text,
      fallback: null,
    };
  }

  logger.info("Analysis text fallback used", {
    orderId: row["Order ID"],
    source: preferred.source,
  });
  return {
    text: preferred.text,
    fallback: createFallbackResolution("analysis_text", preferred.source),
  };
}

function formatFallbackDateTime(value) {
  return formatDateTimeValue(value, cleanTableValue(value));
}

function buildFallbackAddress(row) {
  const village = cleanTableValue(getFirstRowValue(row, VILLAGE_COLUMNS));
  const district = cleanTableValue(getFirstRowValue(row, DISTRICT_COLUMNS));
  const city = cleanTableValue(row[CITY_COLUMN]);
  const parts = [];

  if (village !== "-") {
    parts.push(`Kelurahan ${village}`);
  }
  if (district !== "-") {
    parts.push(`Kecamatan ${district}`);
  }
  if (city !== "-") {
    parts.push(`Kabupaten/Kota ${city}`);
  }

  return {
    text: parts.join(", "),
    missing_fields: [
      village === "-" ? VILLAGE_COLUMNS[0] : "",
      district === "-" ? DISTRICT_COLUMNS[0] : "",
      city === "-" ? CITY_COLUMN : "",
    ].filter(Boolean),
  };
}

function buildFallbackNotes(row) {
  const problemStartTime = formatFallbackDateTime(
    getFirstRowValue(row, PROBLEM_START_TIME_COLUMNS),
  );
  const interactionDate = formatFallbackDateTime(
    getFirstRowValue(row, CUSTOMER_INTERACTION_DATE_COLUMNS),
  );
  const msisdn = cleanTableValue(
    getFirstRowValue(row, CUSTOMER_MSISDN_COLUMNS),
  );
  const complaintDetail = cleanMultilineText(
    getFirstRowValue(row, COMPLAINT_DESCRIPTION_COLUMNS),
  );
  const address = buildFallbackAddress(row);
  const missingFields = [
    problemStartTime === "-" ? PROBLEM_START_TIME_COLUMNS[0] : "",
    interactionDate === "-" ? CUSTOMER_INTERACTION_DATE_COLUMNS[0] : "",
    msisdn === "-" ? CUSTOMER_MSISDN_COLUMNS[0] : "",
    ...address.missing_fields,
    !complaintDetail ? COMPLAINT_DESCRIPTION_COLUMNS[0] : "",
  ].filter(Boolean);
  const lines = [
    `Problem Start Time : ${problemStartTime}`,
    `Customer Interaction Date : ${interactionDate}`,
    `Customer MSISDN : ${msisdn}`,
    `Alamat : ${address.text || "-"}`,
    `Complaint Detail : ${complaintDetail || "-"}`,
  ];
  const hasUsefulValue = lines.some((line) => !line.endsWith(": -"));

  if (!hasUsefulValue) {
    logger.warn("Notes fallback is unavailable", {
      orderId: row["Order ID"],
      missingFields,
    });
    return {
      text: "",
      fallback: null,
    };
  }

  logger.info("Notes fallback generated from ticket columns", {
    orderId: row["Order ID"],
    missingFields,
  });

  return {
    text: lines.join("\n"),
    fallback: createFallbackResolution(
      "notes",
      "Problem Start Time, Customer Interaction Date, Customer MSISDN, Address, Description",
      missingFields,
    ),
  };
}

function getNotesText(row) {
  const notes = cleanMultilineText(row[DESCRIPTION_COLUMN]);
  if (notes) {
    return {
      text: notes,
      fallback: null,
    };
  }

  return buildFallbackNotes(row);
}

function createTicketFallbackMetadata(...fallbacks) {
  return fallbacks.filter(Boolean);
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
  const enabled =
    businessStatus === "reopen" &&
    filledColumns.length === REOPEN_FILLED_CHECK_COLUMNS.length;

  logger.info("Resolved ReOpen message rule", {
    orderId: row["Order ID"],
    businessStatus: row["Business Status"],
    enabled,
    filledColumnsCount: filledColumns.length,
    totalRequiredColumns: REOPEN_FILLED_CHECK_COLUMNS.length,
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
  const notesResult = getNotesText(row);
  const analysisResult = getAnalysisText(row);

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
    msisdn: getFirstRowValue(row, CUSTOMER_MSISDN_COLUMNS),
    raw_description: row[DESCRIPTION_COLUMN] || row["Description"] || "",
    row_raw: row,
    ccm_analysis: cleanMultilineText(
      getFirstRowValue(row, RESOLUTION_L2_ASSIGN_COLUMNS),
    ),
    resolution_l2: cleanMultilineText(
      getFirstRowValue(row, RESOLUTION_L2_ASSIGN_COLUMNS),
    ),
    notes: notesResult.text,
    analysis_text: analysisResult.text,
    problem_analysis: cleanMultilineText(row[PROBLEM_ANALYSIS_COLUMN]),
    fallback_resolutions: createTicketFallbackMetadata(
      notesResult.fallback,
      analysisResult.fallback,
    ),
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
  return processTicketRows(rows);
}

export function processTicketRows(rows) {
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

    const businessStatus = String(ticket.business_status || "")
      .trim()
      .toLowerCase();
    const reopenNum = Number(cleanTableValue(ticket.reopen_number));
    const isReopen =
      businessStatus === "reopen" ||
      (Number.isFinite(reopenNum) && reopenNum > 0);

    let siteVisitClone = null;
    if (isReopen && Number.isFinite(reopenNum)) {
      if (reopenNum > 3) {
        // ReOpen > 3: Routed EXCLUSIVELY to Site Visit, NOT sent to SQA
        ticket.is_repetitive = true;
        ticket.targetGroupKey = "SITE VISIT";
        ticket.ts_site_visit = resolveTsSiteVisit(ticket);
        ticket.anomaly_info = `Tiket ReOpen (${reopenNum}X > 3) Repetitif -> Dialihkan ke Grup Site Visit`;
      } else if (reopenNum === 3) {
        // ReOpen == 3: Sent to SQA as usual AND cloned to Site Visit
        siteVisitClone = {
          ...ticket,
          is_repetitive: true,
          targetGroupKey: "SITE VISIT",
          ts_site_visit: resolveTsSiteVisit(ticket),
          anomaly_info: `Tiket ReOpen (3X) Repetitif -> Dikirim ke SQA dan Grup Site Visit`,
        };
      }
    }

    let anomalyInfo = ticket.anomaly_info || picResult.anomaly_info || null;
    if (!anomalyInfo) {
      if (
        !siteResolution.ok &&
        siteResolution.reason === "SITE_ID_NOT_FOUND_IN_NOP_DATA"
      ) {
        anomalyInfo = `Site ID (${siteResolution.site_id}) tidak ada di DB site -> Diproses ke PIC Kota ${cityResolution.city}`;
      } else if (
        !siteResolution.ok &&
        siteResolution.reason === "SITE_ID_EMPTY_AND_SITE_COVER_NOT_FOUND"
      ) {
        anomalyInfo = `Site ID & Site Cover kosong -> Diproses ke PIC Kota ${cityResolution.city}`;
      } else if (
        siteResolution.source === "problem_analysis_nsh" ||
        siteResolution.source === "extracted_from_row"
      ) {
        anomalyInfo = `Site ID (${ticket.site_id}) diekstrak dari teks -> Ditemukan via ${shortenNopName(siteResolution.source)}`;
      } else if (
        ticket.fallback_resolutions &&
        ticket.fallback_resolutions.length > 0
      ) {
        const fields = ticket.fallback_resolutions
          .map((f) => f.field)
          .join(", ");
        anomalyInfo = `Data (${fields}) tidak lengkap -> Menggunakan fallback teks alternatif/NSH`;
      }
    }
    ticket.anomaly_info = anomalyInfo;
    validTickets.push(ticket);

    if (siteVisitClone) {
      validTickets.push(siteVisitClone);
    }

    logger.info("Row marked valid", {
      rowNumber,
      orderId: ticket.order_id,
      assignmentType: ticket.assignment_type,
      pic: ticket.pic,
      isRepetitive: ticket.is_repetitive,
      hasClone: Boolean(siteVisitClone),
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
      fallback_resolutions: ticket.fallback_resolutions,
      anomaly_info: ticket.anomaly_info,
      is_repetitive: ticket.is_repetitive,
    });
    if (siteVisitClone) {
      processingLog.push({
        status: "VALID",
        row_number: rowNumber,
        order_id: siteVisitClone.order_id,
        ticket_id: siteVisitClone.ticket_id,
        city: siteVisitClone.city,
        assignment_group: siteVisitClone.assignment_group,
        assignment_type: "SITE_VISIT",
        sla_status: siteVisitClone.sla_status,
        pic: siteVisitClone.pic,
        ccm_handling: siteVisitClone.ccm_handling,
        nsa: siteVisitClone.nsa,
        city_source: siteVisitClone.city_source,
        site_cover: siteVisitClone.site_cover,
        site_id: siteVisitClone.site_id,
        vendor: siteVisitClone.vendor,
        cluster_area: siteVisitClone.cluster_area,
        use_reopen_message_format: false,
        reopen_number: siteVisitClone.reopen_number,
        reopen_filled_columns: siteVisitClone.reopen_filled_columns,
        fallback_resolutions: siteVisitClone.fallback_resolutions,
        anomaly_info: siteVisitClone.anomaly_info,
        is_repetitive: true,
      });
    }
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
export function formatImportSummary(result, options = {}) {
  logger.info("Formatting import summary", { ok: result.ok });
  if (!result.ok) {
    return [
      "⚠️ **Gagal Memproses Excel**",
      "",
      `Alasan: ${result.reason || "Format tidak valid"}`,
      result.detail ? `Detail: ${result.detail}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const modeTag = options.mode ? ` (Mode \`${options.mode}\`)` : "";
  const lines = [
    `✅ Import tiket selesai.${modeTag}`,
    "",
    `📊 Total row: ${result.total_rows}`,
    `✔️ Tiket valid: ${result.valid_count}`,
    `⏭️ Tiket dilewati: ${result.skipped_count}`,
  ];

  if (options.modeNote) {
    lines.push("", `ℹ️ ${options.modeNote}`);
  }

  return lines.join("\n");
}

function formatSkippedAnomalyDetail(t) {
  if (t.anomaly_info) {
    return `${t.anomaly_info} (${t.reason})`;
  }

  const cityVal = t.city && t.city !== "-" ? t.city : "";
  const siteVal = t.site_id || t.site_cover || "";

  if (cityVal && siteVal) {
    return `Kota ${cityVal} (${siteVal}) di luar Region Sumbagut (${t.reason})`;
  }
  if (cityVal) {
    return `Kota ${cityVal} di luar Region Sumbagut (${t.reason})`;
  }
  if (siteVal) {
    return `Site ${siteVal} tidak terdaftar di DB Sumbagut (${t.reason})`;
  }
  return `Kota & Site Cover tidak ditemukan pada tiket (${t.reason})`;
}

export function shortenNopName(value) {
  const text = String(value || "")
    .trim()
    .replace(/^group\s*:\s*/i, "");
  if (!text) {
    return "-";
  }

  return text
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+PADANG\s+SIDEMPUAN\b/gi, "NOP PSP")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+RANTAU\s+PRAPAT\b/gi, "NOP RAP")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+PEMATANG\s*SIANTAR\b/gi, "NOP PMS")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+BINJAI\b/gi, "NOP BJI")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+MEDAN\b/gi, "NOP MDN")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+BANDA\s+ACEH\b/gi, "NOP ACEH")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+ACEH\b/gi, "NOP ACEH")
    .replace(/\bNETWORK OPERATIONS? AND PRODUCTIVITY\s+/gi, "NOP ")
    .replace(/\bNOP\s+PADANG\s+SIDEMPUAN\b/gi, "NOP PSP")
    .replace(/\bNOP\s+RANTAU\s+PRAPAT\b/gi, "NOP RAP")
    .replace(/\bNOP\s+PEMATANG\s*SIANTAR\b/gi, "NOP PMS")
    .replace(/\bNOP\s+BINJAI\b/gi, "NOP BJI")
    .replace(/\bNOP\s+MEDAN\b/gi, "NOP MDN")
    .replace(/\bNOP\s+BANDA\s+ACEH\b/gi, "NOP ACEH")
    .replace(/\bNOP\s+ACEH\b/gi, "NOP ACEH")
    .replace(/\bSERVICE QUALITY ASSURANCE\s+SUMBAGUT\b/gi, "SQA")
    .replace(/\bSERVICE QUALITY ASSURANCE\b/gi, "SQA");
}

export const formatShortGroupName = shortenNopName;

function formatValidAnomalyCard(t) {
  const ref = getTicketRef(t);
  const rawGroup = t.assignment_group || t.assignment_type || "-";
  const group = shortenNopName(rawGroup);
  const pic = t.pic || "-";
  const anomalyRaw = String(t.anomaly_info || "").trim();

  let kasus = anomalyRaw;
  let fallback = "Tetap diproses dengan mapping PIC alternatif";

  if (anomalyRaw.includes(" -> ")) {
    const [part1, part2] = anomalyRaw.split(" -> ");
    kasus = part1.trim();
    fallback = part2.trim();
  }

  kasus = shortenNopName(kasus);
  fallback = shortenNopName(fallback);

  return [
    `📌 \`${ref}\` (${group})`,
    `   ├ ⚠️ **Anomali**: ${kasus}`,
    `   ├ 🔄 **Aksi Fallback**: ${fallback}`,
    `   └ 👤 **PIC**: **${pic}**`,
  ].join("\n");
}

function formatSkippedAnomalyCard(t) {
  const ref = getTicketRef(t);
  const rawGroup = t.assignment_group || "SQA";
  const group = shortenNopName(rawGroup);
  const detail = formatSkippedAnomalyDetail(t);

  return [
    `❌ \`${ref}\` (${group})`,
    `   └ ⚠️ **Alasan Skip**: ${shortenNopName(detail)}`,
  ].join("\n");
}

// membuat report detail alasan tiket valid/dilewati agar proses filter bisa diaudit dari WhatsApp/Telegram.
export function formatProcessingReport(result) {
  logger.info("Formatting processing report", { ok: result.ok });
  if (!result.ok) {
    return "";
  }

  const lines = [
    "📊 **Report Proses Import Tiket**",
    "",
    "🗂️ **Valid per Assignment**:",
    createCodeBlock(
      formatAsciiTable(
        [
          { key: "assignment_type", header: "Assignment Type", minWidth: 15 },
          { key: "count", header: "Count", minWidth: 5 },
        ],
        Object.entries(result.valid_by_assignment_type).map(([key, count]) => ({
          assignment_type: key,
          count,
        })),
      ),
    ),
    "",
    "👤 **Valid per PIC**:",
    createCodeBlock(
      formatAsciiTable(
        [
          { key: "pic", header: "PIC", minWidth: 12, maxWidth: 24 },
          { key: "count", header: "Count", minWidth: 5 },
        ],
        Object.entries(result.valid_by_pic).map(([key, count]) => ({
          pic: key,
          count,
        })),
      ),
    ),
  ];

  const repetitiveTickets = (result.valid_tickets || []).filter(
    (t) => t.is_repetitive || t.targetGroupKey === "SITE VISIT",
  );
  if (repetitiveTickets.length > 0) {
    lines.push(
      "",
      `🔁 **Tiket Repetitif (>3 ReOpen / Site Visit)**: (${repetitiveTickets.length} tiket)`,
      "ℹ️ *Tiket ini akan dikirimkan ke grup **SITE VISIT** setelah seluruh tiket utama (SQA & NOP) selesai dikirim.*",
      ...repetitiveTickets.map((t) => {
        const tsNames =
          (t.ts_site_visit || []).map((ts) => ts.name).join(", ") || "-";
        const reopenText = t.reopen_number ? `${t.reopen_number}X` : "-";
        return [
          `📌 \`${t.order_id || "-"}\` (ReOpen: ${reopenText})`,
          `   ├ 📍 Kota/Area: ${t.city || t.cluster_area || "-"}`,
          `   └ 👷 PIC TS Site Visit: ${tsNames}`,
        ].join("\n");
      }),
    );
  }

  const validAnomalies = (result.valid_tickets || []).filter(
    (t) => t.anomaly_info && !t.is_repetitive && t.targetGroupKey !== "SITE VISIT",
  );
  if (validAnomalies.length > 0) {
    lines.push(
      "",
      "⚠️ **Tiket Anomali (Tetap Terkirim ke WA)**:",
      ...validAnomalies.map((t) => formatValidAnomalyCard(t)),
    );
  }

  const skippedAnomalies = (result.skipped_tickets || []).filter(
    (t) =>
      t.anomaly_info ||
      t.reason === "CITY_NOT_FOUND" ||
      t.reason === "SITE_COVER_NOT_FOUND_IN_NOP_DATA" ||
      t.reason === "CITY_EMPTY_AND_SITE_COVER_NOT_FOUND",
  );
  if (skippedAnomalies.length > 0) {
    lines.push(
      "",
      "⚠️ **Tiket Anomali Dilewati (Tidak Dikirim ke WA)**:",
      ...skippedAnomalies.map((t) => formatSkippedAnomalyCard(t)),
    );
  }

  if (result.skipped_tickets.length > 0) {
    lines.push(
      "",
      "⏭️ Alasan dilewati:",
      ...Object.entries(result.skipped_by_reason).map(
        ([key, count]) => `- ${key}: ${count}`,
      ),
      "",
      "📋 Detail tiket yang dilewati:",
      createCodeBlock(
        formatAsciiTable(
          [
            { key: "order_id", header: "Order ID", minWidth: 20, maxWidth: 24 },
            { key: "reason", header: "Reason", minWidth: 22, maxWidth: 32 },
            { key: "city", header: "City", minWidth: 12, maxWidth: 18 },
            {
              key: "assignment_group",
              header: "Assignment Group",
              minWidth: 18,
              maxWidth: 34,
            },
          ],
          result.skipped_tickets.map((ticket) => ({
            order_id: getTicketRef(ticket),
            reason: ticket.reason,
            city: ticket.city || "-",
            assignment_group: ticket.assignment_group || "-",
          })),
        ),
      ),
    );
  }

  if (result.valid_tickets.length > 0) {
    const tableColumns = [
      { key: "order_id", header: "Order ID", minWidth: 20, maxWidth: 24 },
      { key: "city", header: "City", minWidth: 12, maxWidth: 18 },
      { key: "cluster_area", header: "Cluster Area", minWidth: 14, maxWidth: 20 },
      { key: "sla_status", header: "SLA Status", minWidth: 10 },
      { key: "pic", header: "PIC", minWidth: 12, maxWidth: 24 },
      { key: "site_id", header: "Site ID", minWidth: 7, maxWidth: 10 },
    ];

    const mapTicketToRow = (ticket) => ({
      order_id: getTicketRef(ticket),
      city: ticket.city || "-",
      cluster_area:
        ticket.cluster_area ||
        ticket.departemen_ns ||
        ticket.departement_ns ||
        ticket.nsa ||
        "-",
      sla_status: ticket.sla_status || "-",
      pic: ticket.pic || "-",
      site_id: ticket.site_id || "-",
    });

    const sqaTickets = result.valid_tickets.filter(
      (ticket) => ticket.assignment_type === "SQA",
    );
    const nopTickets = result.valid_tickets.filter(
      (ticket) => ticket.assignment_type === "NOP",
    );
    const otherTickets = result.valid_tickets.filter(
      (ticket) =>
        ticket.assignment_type !== "SQA" && ticket.assignment_type !== "NOP",
    );

    lines.push("", "📋 Detail tiket yang valid:");

    if (sqaTickets.length > 0) {
      lines.push(
        "SQA",
        createCodeBlock(
          formatAsciiTable(tableColumns, sqaTickets.map(mapTicketToRow)),
        ),
      );
    }

    if (nopTickets.length > 0) {
      if (sqaTickets.length > 0) {
        lines.push("");
      }
      lines.push(
        "NOP",
        createCodeBlock(
          formatAsciiTable(tableColumns, nopTickets.map(mapTicketToRow)),
        ),
      );
    }

    if (otherTickets.length > 0) {
      if (sqaTickets.length > 0 || nopTickets.length > 0) {
        lines.push("");
      }
      lines.push(
        "OTHER",
        createCodeBlock(
          formatAsciiTable(tableColumns, otherTickets.map(mapTicketToRow)),
        ),
      );
    }
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

// membuat nama pendek NOP seperti BJI dari cluster area/NOP asal tiket.
function getNopReminderName(tickets) {
  const firstTicket = tickets[0] || {};
  const source = cleanTableValue(
    firstTicket.cluster_area || firstTicket.nsa || firstTicket.assignment_group,
  )
    .replace(/^NOP\s+/i, "")
    .toUpperCase();

  return normalizeNopAreaName(source) || "NOP";
}

function normalizeNopAreaName(value) {
  const source = cleanTableValue(value)
    .replace(/^NOP\s+/i, "")
    .toUpperCase()
    .trim();
  const compactSource = source.replace(/\s+/g, "");

  return NOP_SHORT_NAMES[source] || NOP_SHORT_NAMES[compactSource] || source;
}

function getReminderDepartmentName(ticket) {
  const department = cleanTableValue(
    ticket.departement_ns ||
      ticket.departemen_ns ||
      ticket.cluster_area ||
      ticket.nsa ||
      ticket.city,
  );

  return normalizeNopAreaName(department) || "-";
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// mengambil teks remark Problem Analysis untuk tabel reminder.
function getpreviousProblemAnalysis(ticket) {
  const text = cleanTableValue(cleanMultilineText(ticket.problem_analysis));
  if (!text || text === "-") {
    return "-";
  }

  const stopPatterns = [
    /\bperkiraan\s+site\b/i,
    /\bdominant\s+cell\b/i,
    /\bpotensial\s+problem\b/i,
    /\bcat?egor[yi]\s+problem\b/i,
  ];
  const stopIndexes = stopPatterns
    .map((pattern) => text.search(pattern))
    .filter((index) => index >= 0);
  const processedText =
    stopIndexes.length > 0 ? text.slice(0, Math.min(...stopIndexes)) : text;

  const sentences = processedText
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let resultText = processedText;
  if (sentences.length > 0) {
    const firstSentence = sentences[0];
    const wordCountFirst = countWords(firstSentence);

    if (wordCountFirst >= 15) {
      resultText = firstSentence;
    } else if (sentences.length >= 2) {
      resultText = `${firstSentence} ${sentences[1]}`;
    }
  }

  return (
    resultText
      .replace(/\s+/g, " ")
      .replace(/\s+[.,;:]+$/g, "")
      .trim() || "-"
  );
}

// mengambil nilai Count ReOpen dari kolom Reopen Number(Confirm Close).
function getReopenCount(ticket) {
  const value = cleanTableValue(ticket.reopen_number);
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && Number.isInteger(numericValue)) {
    return String(numericValue);
  }
  return value;
}

function extractReminderSiteIdFromProblemAnalysis(ticket) {
  const problemAnalysis = cleanMultilineText(ticket.problem_analysis);
  const siteCover = extractSiteCover(problemAnalysis);
  if (siteCover) {
    return siteCover;
  }

  const text = cleanTableValue(problemAnalysis);
  const match = text.match(
    /\b(?:site\s+cover|di\s+cover|cover)\s+([A-Z]{2,5}\d{2,5})\b/i,
  );
  return match ? match[1].toUpperCase() : "";
}

function getReminderSiteId(ticket) {
  return cleanTableValue(
    extractReminderSiteIdFromProblemAnalysis(ticket) || ticket.site_id,
  );
}

function hasRequiredReminderDetailData(ticket) {
  return [
    cleanTableValue(ticket.order_id),
    getReminderSiteId(ticket),
    getReopenCount(ticket),
    getpreviousProblemAnalysis(ticket),
  ].every((value) => value && value !== "-");
}

export {
  GROUP_OPENING_MESSAGE,
  INDONESIAN_MONTHS_FULL,
  formatSqaReminderMessage,
  formatNopReminderMessage,
  formatTargetGroupOpeningMessage,
  formatUpdateTicketFileName,
  formatReminderMessagePayload,
  formatReopenEscalationText,
  isOutSlaInProgressTicket,
  formatOutSlaInProgressEscalationText,
  getReminderAssigneeTag,
  getInProgressReminderTargetName,
  parseFormattedDueDate,
  formatOverdueTime,
  getInProgressReminderLine,
  formatInProgressReminderMessagePayload,
  formatEscalationMessagePayload,
  formatEscalationMessage,
  formatRepetitiveEscalationPayload,
  formatSiteVisitCombinedReminderPayload,
  extractCustomerDetailsSummary,
  extractRepetitiveNote,
  getReopenCount,
  getReminderSiteId,
  getpreviousProblemAnalysis,
  getReminderDepartmentName,
  getNopReminderName,
  summarizeSla,
  hasRequiredReminderDetailData,
  hasRequiredNopReminderDetailData,
  getReopenReminderTickets,
} from "./messageTemplateService.js";


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
