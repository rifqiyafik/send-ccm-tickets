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

// mengambil site ID dari teks Problem Analysis NSH dengan pola #Site Cover / #SiteCover.
export function extractSiteCover(problemAnalysis) {
  logger.debug("Extracting site cover from Problem Analysis NSH");
  const text = String(problemAnalysis ?? "");
  const match = text.match(/#\s*site\s*cover\s*:?\s*([A-Z]{2,5}\d{2,5})/i);

  const siteId = match ? normalizeText(match[1]) : null;
  logger.debug("Site cover extraction result", { siteId });
  return siteId;
}

// membuat index site_id -> data site agar search ke JSON NOP cepat dan konsisten.
function buildSiteIndex(rows) {
  logger.info("Building NOP site index", { rows: rows.length });
  return new Map(
    rows
      .filter((row) => row && row.site_id)
      .map((row) => [normalizeText(row.site_id), row])
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

// membuat resolver city; prioritas kolom Kabupaten/Kota, fallback site cover dari Problem Analysis NSH.
export function createCityResolver(options = {}) {
  const rows = options.rows || (options.filePath ? loadNopSiteRows(options.filePath) : null);
  const siteIndex = options.siteIndex || (rows ? buildSiteIndex(rows) : defaultSiteIndex);

  return function resolveCityFromTicketRow(row) {
    logger.info("Resolving city from ticket row", { orderId: row?.["Order ID"] });
    const directCity = normalizeText(row?.[CITY_COLUMN]);
    if (directCity) {
      logger.info("City resolved from city column", { city: directCity });
      return {
        ok: true,
        city: directCity,
        source: "city_column",
        site_id: null,
      };
    }

    const siteId = extractSiteCover(row?.[PROBLEM_ANALYSIS_NSH_COLUMN]);
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
    const siteId = directSiteId || extractSiteCover(row?.[PROBLEM_ANALYSIS_NSH_COLUMN]);

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
      source: directSiteId ? "site_id1_column" : "problem_analysis_nsh",
    };
    logger.info("Site resolved", result);
    return result;
  };
}

export const resolveSiteFromTicketRow = createSiteResolver();
