import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
import { readJsonArray } from "../utils/jsonFile.js";
import { normalizeSearchKey } from "../utils/text.js";

const logger = createLogger("picSearchService");

const CCM_HANDLING_FILE_NAME = "ccm_handling_sqa_region_sumbagut.json";

function resolveCcmHandlingPath() {
  const candidates = [
    process.env.CCM_HANDLING_DATA_PATH,
    path.resolve(process.cwd(), "data", CCM_HANDLING_FILE_NAME),
    path.resolve(process.cwd(), "reference-data", CCM_HANDLING_FILE_NAME),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  const filePath = found || candidates[0];
  logger.info("Resolved CCM handling data path", {
    filePath,
    candidates,
    found: Boolean(found),
  });
  return filePath;
}

const SQA_ASSIGNMENT_GROUP = "SERVICE QUALITY ASSURANCE SUMBAGUT";
const NOP_ASSIGNMENT_PREFIX = "NETWORK OPERATIONS AND PRODUCTIVITY ";
export const CITY_COLUMN = "Kabupaten/Kota(Create Ticket)";
export const ASSIGNMENT_GROUP_COLUMN = "Assign to L2(L2 Assign)";

const ASSIGNMENT_ALIASES = new Map([
  [
    "NETWORK OPERATIONS AND PRODUCTIVITY BANDA ACEH",
    "NETWORK OPERATIONS AND PRODUCTIVITY ACEH",
  ],
]);

export const normalizeText = normalizeSearchKey;

// mengambil city dari kolom Kabupaten/Kota(Create Ticket) dalam format search.
export function getCityFromTicketRow(row) {
  const city = normalizeText(row?.[CITY_COLUMN]);
  logger.debug("Read city from ticket row", { city });
  return city;
}

// membersihkan assignment group dari prefix group: dan menyamakan alias area.
export function normalizeAssignmentGroup(value) {
  logger.debug("Normalizing assignment group", { value });
  const withoutPrefix = String(value ?? "")
    .trim()
    .replace(/^group\s*:\s*/i, "");

  const normalized = normalizeText(withoutPrefix);
  const result = ASSIGNMENT_ALIASES.get(normalized) || normalized;
  logger.debug("Assignment group normalized", { result });
  return result;
}

// menentukan apakah assignment masuk SQA, NOP, atau tidak didukung.
export function getAssignmentType(assignmentGroup) {
  const normalized = normalizeAssignmentGroup(assignmentGroup);

  if (normalized === SQA_ASSIGNMENT_GROUP) {
    logger.debug("Assignment type detected", { assignmentType: "SQA" });
    return "SQA";
  }

  if (normalized.startsWith(NOP_ASSIGNMENT_PREFIX)) {
    logger.debug("Assignment type detected", { assignmentType: "NOP" });
    return "NOP";
  }

  logger.debug("Assignment type detected", { assignmentType: "UNKNOWN" });
  return "UNKNOWN";
}

// membuat index city -> data CCM handling agar search PIC berbasis kota cepat.
function buildCityIndex(rows) {
  logger.info("Building CCM handling city index", { rows: rows.length });
  return new Map(
    rows
      .filter((row) => row && row.city)
      .map((row) => [normalizeText(row.city), row])
  );
}

// membaca database CCM handling yang berisi PIC CCM, PIC SQA, dan PIC NOP per city.
export function loadCcmHandlingRows(filePath = resolveCcmHandlingPath()) {
  try {
    logger.info("Loading CCM handling data", { filePath });
    const rows = readJsonArray(filePath, "CCM handling data");

    logger.info("CCM handling data loaded", { rows: rows.length });
    return rows;
  } catch (error) {
    logger.error("Failed to load CCM handling data", error);
    throw error;
  }
}

// membuat search PIC; SQA mengambil pic_sqa/ccm_handling, NOP mengambil pic_nop.
import { extractCityFromDescription } from "../utils/descriptionCityExtractor.js";

function isNopAreaMatch(cityRecord, normalizedAssignmentGroup) {
  if (!cityRecord?.departement_ns) return true;
  const recordDept = normalizeText(cityRecord.departement_ns);
  const assignGroup = normalizeText(normalizedAssignmentGroup);
  const tokens = ["ACEH", "BINJAI", "MEDAN", "PEMATANG", "RANTAU", "SIDEMPUAN"];
  for (const token of tokens) {
    if (assignGroup.includes(token)) {
      return recordDept.includes(token);
    }
  }
  return true;
}

// membuat search PIC; SQA mengambil pic_sqa/ccm_handling, NOP mengambil pic_nop.
export function createPicSearch(options = {}) {
  const rows = options.rows || loadCcmHandlingRows(options.filePath);
  const cityIndex = buildCityIndex(rows);

  return function searchPicByCityAndAssignment({
    city,
    assignmentGroup,
    descriptionText = "",
  }) {
    logger.info("Searching PIC by city and assignment", {
      city,
      assignmentGroup,
    });
    const normalizedCity = normalizeText(city);
    const normalizedAssignmentGroup =
      normalizeAssignmentGroup(assignmentGroup);
    const assignmentType = getAssignmentType(normalizedAssignmentGroup);

    let effectiveCityRecord = cityIndex.get(normalizedCity);
    let anomalyInfo = null;

    const needsDescriptionScan =
      !effectiveCityRecord ||
      (assignmentType === "NOP" &&
        !isNopAreaMatch(effectiveCityRecord, normalizedAssignmentGroup));

    if (needsDescriptionScan && descriptionText) {
      const extractedCity = extractCityFromDescription(descriptionText, rows);
      if (extractedCity) {
        const descCityRecord = cityIndex.get(normalizeText(extractedCity));
        if (descCityRecord) {
          if (assignmentType === "NOP") {
            if (isNopAreaMatch(descCityRecord, normalizedAssignmentGroup)) {
              const primaryCityName =
                effectiveCityRecord?.city || normalizedCity || "Unknown";
              effectiveCityRecord = descCityRecord;
              anomalyInfo = `Mismatch Kota Utama (${primaryCityName}) -> Ekstrak Deskripsi: ${descCityRecord.city}`;
            }
          } else {
            effectiveCityRecord = descCityRecord;
            anomalyInfo = `Ekstrak Deskripsi: ${descCityRecord.city}`;
          }
        }
      }
    }

    if (
      assignmentType === "NOP" &&
      (!effectiveCityRecord ||
        !isNopAreaMatch(effectiveCityRecord, normalizedAssignmentGroup))
    ) {
      const assignGroupToken = [
        "ACEH",
        "BINJAI",
        "MEDAN",
        "PEMATANG",
        "RANTAU",
        "SIDEMPUAN",
      ].find((t) => normalizeText(normalizedAssignmentGroup).includes(t));
      const fallbackRecord = rows.find(
        (r) =>
          r &&
          r.departement_ns &&
          normalizeText(r.departement_ns).includes(assignGroupToken),
      );
      if (fallbackRecord) {
        const prevCity =
          effectiveCityRecord?.city || normalizedCity || "Luar Region";
        effectiveCityRecord = fallbackRecord;
        anomalyInfo = `Site/Deskripsi Luar Region (${prevCity}) -> Fallback PIC Default ${fallbackRecord.departement_ns.trim()}`;
      }
    }

    if (!effectiveCityRecord) {
      logger.warn("PIC search failed: city not found", {
        city: normalizedCity,
        assignmentGroup: normalizedAssignmentGroup,
      });
      return {
        ok: false,
        reason: "CITY_NOT_FOUND",
        city: normalizedCity,
        assignment_group: normalizedAssignmentGroup,
        assignment_type: assignmentType,
        anomaly_info: `Kota/Site (${normalizedCity || "Luar Region"}) di luar Region Sumbagut`,
      };
    }

    if (assignmentType === "SQA") {
      const result = {
        ok: true,
        assignment_type: "SQA",
        assignment_group: normalizedAssignmentGroup,
        city: effectiveCityRecord.city,
        nsa: effectiveCityRecord.nsa,
        ccm_handling: effectiveCityRecord.ccm_handling,
        pic: effectiveCityRecord.pic_sqa,
        pic_sqa: effectiveCityRecord.pic_sqa,
        pic_nop: effectiveCityRecord.pic_nop,
        source: "ccm_handling_sqa_region_sumbagut",
        anomaly_info: anomalyInfo,
      };
      logger.info("PIC search success for SQA", result);
      return result;
    }

    if (assignmentType === "NOP") {
      const result = {
        ok: true,
        assignment_type: "NOP",
        assignment_group: normalizedAssignmentGroup,
        city: effectiveCityRecord.city,
        nsa: effectiveCityRecord.nsa,
        ccm_handling: effectiveCityRecord.ccm_handling,
        pic: effectiveCityRecord.pic_nop,
        pic_sqa: effectiveCityRecord.pic_sqa,
        pic_nop: effectiveCityRecord.pic_nop,
        source: "ccm_handling_sqa_region_sumbagut",
        anomaly_info: anomalyInfo,
      };
      logger.info("PIC search success for NOP", result);
      return result;
    }

    logger.warn("PIC search failed: assignment group not supported", {
      city: effectiveCityRecord.city,
      assignmentGroup: normalizedAssignmentGroup,
    });
    return {
      ok: false,
      reason: "ASSIGNMENT_GROUP_NOT_SUPPORTED",
      city: effectiveCityRecord.city,
      assignment_group: normalizedAssignmentGroup,
      assignment_type: assignmentType,
      nsa: effectiveCityRecord.nsa,
      ccm_handling: effectiveCityRecord.ccm_handling,
    };
  };
}

export const searchPicByCityAndAssignment = createPicSearch();

export const createPicLookup = createPicSearch;
export const lookupPicByCityAndAssignment = searchPicByCityAndAssignment;

// adapter untuk search PIC langsung dari row Excel yang sudah punya city dan assignment group.
export function searchPicFromTicketRow(row) {
  logger.info("Searching PIC from ticket row", { orderId: row?.["Order ID"] });
  const descriptionText =
    row?.[
      "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"
    ] ||
    row?.["Description"] ||
    "";
  return searchPicByCityAndAssignment({
    city: row?.[CITY_COLUMN],
    assignmentGroup: row?.[ASSIGNMENT_GROUP_COLUMN],
    descriptionText,
  });
}

export const lookupPicFromTicketRow = searchPicFromTicketRow;

export { SQA_ASSIGNMENT_GROUP, NOP_ASSIGNMENT_PREFIX };
