import path from "path";
import fs from "fs";

import { CITY_COLUMN, normalizeText } from "./picSearchService.js";
import { createLogger } from "../utils/logger.js";
import { readJsonArray } from "../utils/jsonFile.js";

const logger = createLogger("siteSearchService");

export const PROBLEM_ANALYSIS_NSH_COLUMN = "Problem Analysis NSH";
export const SITE_ID1_COLUMN = "site_id1(L1 Assign)";

const NOP_SITE_FILE_NAME = "pic_nop_region_sumbagut.json";

function resolveNopSitePath() {
  const candidates = [
    process.env.NOP_SITE_DATA_PATH,
    path.resolve(process.cwd(), "data", NOP_SITE_FILE_NAME),
    path.resolve(process.cwd(), "reference-data", NOP_SITE_FILE_NAME),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  const filePath = found || candidates[0];
  logger.info("Resolved NOP site data path", {
    filePath,
    candidates,
    found: Boolean(found),
  });
  return filePath;
}
const defaultNopSiteRows = loadNopSiteRows();
const defaultSiteIndex = buildSiteIndex(defaultNopSiteRows);

// mengambil site ID dari teks dengan pola #Site Cover, Site Cover, Site ID, atau eNodeB cell.
export function extractSiteCover(textInput) {
  logger.debug("Extracting site cover from text");
  const text = String(textInput ?? "");
  if (!text.trim()) return null;

  // 1. Match explicit #Site Cover, Site Cover, atau Site ID (dengan/tanpa #)
  const siteCoverMatch = text.match(
    /#?\s*site\s*(?:cover|id)\s*[:=-]?\s*([A-Z]{2,5}\d{2,5})/i,
  );
  if (siteCoverMatch) {
    const siteId = normalizeText(siteCoverMatch[1]);
    logger.debug("Site cover extraction result from pattern", { siteId });
    return siteId;
  }

  // 2. Match eNodeB / cell pattern seperti E_RAP755SL1 atau N_RAP755MR1
  const cellMatch = text.match(/\b[EN]_([A-Z]{3}\d{3})\w*\b/i);
  if (cellMatch) {
    const siteId = normalizeText(cellMatch[1]);
    logger.debug("Site cover extraction result from cell pattern", { siteId });
    return siteId;
  }

  return null;
}

export function extractSiteCoverFromRow(row, siteIndex = null) {
  const candidateColumns = [
    PROBLEM_ANALYSIS_NSH_COLUMN,
    "CCH Suggestion(L1 Assign_cch_suggestion)",
    "cch_suggestion_2(L1 Assign)",
    "cch_suggestion_3(L1 Assign)",
    "CCH Suggestion 2(L1 Assign)",
    "CCH Suggestion 3(L1 Assign)",
    "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)",
    "Description",
    "Problem Analysis",
    "CCH Smartcare",
  ];

  for (const col of candidateColumns) {
    const text = row?.[col];
    if (text) {
      const siteId = extractSiteCover(text);
      if (siteId) return siteId;
    }
  }

  // Fallback: jika siteIndex diberikan, cari token site_id (misal RAP755) di seluruh teks kolom yang cocok di DB site
  if (siteIndex) {
    for (const col of candidateColumns) {
      const text = String(row?.[col] ?? "");
      if (!text) continue;
      const tokens = text.match(/\b[A-Z]{3}\d{3}\b/gi) || [];
      for (const token of tokens) {
        const normalized = normalizeText(token);
        if (siteIndex.has(normalized)) {
          logger.info("Site cover resolved from token match in text", {
            siteId: normalized,
            column: col,
          });
          return normalized;
        }
      }
    }
  }

  return null;
}

// membuat index site_id -> data site agar search ke JSON NOP cepat dan konsisten.
function buildSiteIndex(rows) {
  logger.info("Building NOP site index", { rows: rows.length });
  return new Map(
    rows
      .filter((row) => row && row.site_id)
      .map((row) => [normalizeText(row.site_id), row]),
  );
}

// membaca database site NOP yang dipakai untuk city fallback, vendor, cluster area, dan site detail.
export function loadNopSiteRows(filePath = resolveNopSitePath()) {
  try {
    logger.info("Loading NOP site data", { filePath });
    const rows = readJsonArray(filePath, "NOP site data");

    logger.info("NOP site data loaded", { rows: rows.length });
    return rows;
  } catch (error) {
    logger.error("Failed to load NOP site data", error);
    throw error;
  }
}

// membuat resolver city; prioritas kolom Kabupaten/Kota, fallback site cover dari Problem Analysis NSH / CCH Suggestion / Deskripsi / eNodeB.
export function createCityResolver(options = {}) {
  const rows =
    options.rows || (options.filePath ? loadNopSiteRows(options.filePath) : null);
  const siteIndex =
    options.siteIndex || (rows ? buildSiteIndex(rows) : defaultSiteIndex);

  return function resolveCityFromTicketRow(row) {
    logger.info("Resolving city from ticket row", { orderId: row?.["Order ID"] });
    const directCity = normalizeText(row?.[CITY_COLUMN]);
    if (directCity && directCity !== "-") {
      logger.info("City resolved from city column", { city: directCity });
      return {
        ok: true,
        city: directCity,
        source: "city_column",
        site_id: null,
      };
    }

    const siteId = extractSiteCoverFromRow(row, siteIndex);
    if (!siteId) {
      logger.warn("City resolution failed: city empty and site cover not found", {
        orderId: row?.["Order ID"],
      });
      return {
        ok: false,
        reason: "CITY_EMPTY_AND_SITE_COVER_NOT_FOUND",
        city: null,
        source: "problem_analysis_nsh",
        site_id: null,
      };
    }

    const siteRecord = siteIndex.get(siteId);
    if (!siteRecord) {
      logger.warn("City resolution failed: site cover not found in NOP data", {
        orderId: row?.["Order ID"],
        siteId,
      });
      return {
        ok: false,
        reason: "SITE_COVER_NOT_FOUND_IN_NOP_DATA",
        city: null,
        source: "problem_analysis_nsh",
        site_id: siteId,
      };
    }

    const result = {
      ok: true,
      city: normalizeText(siteRecord.kabupaten),
      source: "problem_analysis_nsh",
      site_id: siteId,
      site_name: siteRecord.site_name,
      departement_ns: siteRecord.departement_ns,
    };
    logger.info("City resolved from site cover", result);
    return result;
  };
}

export const resolveCityFromTicketRow = createCityResolver();

// membuat resolver site; prioritas site_id1(L1 Assign), fallback site cover dari Problem Analysis NSH.
export function createSiteResolver(options = {}) {
  const rows = options.rows || (options.filePath ? loadNopSiteRows(options.filePath) : null);
  const siteIndex = options.siteIndex || (rows ? buildSiteIndex(rows) : defaultSiteIndex);

  return function resolveSiteFromTicketRow(row) {
    logger.info("Resolving site from ticket row", { orderId: row?.["Order ID"] });
    const directSiteId = normalizeText(row?.[SITE_ID1_COLUMN]);
    const isDirectSiteOpaque =
      /^\d{6,}$/i.test(directSiteId) || /^[0-9A-F]{10,}$/i.test(directSiteId);

    let siteId =
      (!isDirectSiteOpaque && directSiteId) ||
      extractSiteCover(row?.[PROBLEM_ANALYSIS_NSH_COLUMN]);
    let source =
      directSiteId && !isDirectSiteOpaque
        ? "site_id1_column"
        : "problem_analysis_nsh";

    if (!siteId || (siteIndex && !siteIndex.has(siteId))) {
      const coverFromRow = extractSiteCoverFromRow(row, siteIndex);
      if (coverFromRow) {
        siteId = coverFromRow;
        source = "extracted_from_row";
      } else if (!siteId && directSiteId) {
        siteId = directSiteId;
        source = "site_id1_column";
      }
    }

    if (!siteId) {
      logger.warn("Site resolution failed: no site_id1 and no site cover", {
        orderId: row?.["Order ID"],
      });
      return {
        ok: false,
        reason: "SITE_ID_EMPTY_AND_SITE_COVER_NOT_FOUND",
        site_id: null,
      };
    }

    const siteRecord = siteIndex.get(siteId);
    if (!siteRecord) {
      logger.warn("Site resolution failed: site not found in NOP data", {
        orderId: row?.["Order ID"],
        siteId,
      });
      return {
        ok: false,
        reason: "SITE_ID_NOT_FOUND_IN_NOP_DATA",
        site_id: siteId,
      };
    }

    const result = {
      ok: true,
      site_id: siteId,
      site_name: siteRecord.site_name,
      city: normalizeText(siteRecord.kabupaten),
      vendor: siteRecord.vendor || "",
      cluster_area: siteRecord.departement_ns || "",
      departement_ns: siteRecord.departement_ns || "",
      source,
    };
    logger.info("Site resolved", result);
    return result;
  };
}

export const resolveSiteFromTicketRow = createSiteResolver();
