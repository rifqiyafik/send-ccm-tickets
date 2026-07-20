import path from "path";
import { createLogger } from "../utils/logger.js";
import { readJsonArray } from "../utils/jsonFile.js";
import { normalizeSearchKey } from "../utils/text.js";

const logger = createLogger("picSearchService");

const DEFAULT_CCM_HANDLING_PATH = path.resolve(
  process.cwd(),
  "data/ccm_handling_sqa_region_sumbagut.json"
);

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
export function loadCcmHandlingRows(filePath = DEFAULT_CCM_HANDLING_PATH) {
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
export function createPicSearch(options = {}) {
  const rows = options.rows || loadCcmHandlingRows(options.filePath);
  const cityIndex = buildCityIndex(rows);

  return function searchPicByCityAndAssignment({ city, assignmentGroup }) {
    logger.info("Searching PIC by city and assignment", { city, assignmentGroup });
    const normalizedCity = normalizeText(city);
    const normalizedAssignmentGroup = normalizeAssignmentGroup(assignmentGroup);
    const assignmentType = getAssignmentType(normalizedAssignmentGroup);
    const cityRecord = cityIndex.get(normalizedCity);

    if (!normalizedCity) {
      logger.warn("PIC search failed: city empty", { assignmentGroup: normalizedAssignmentGroup });
      return {
        ok: false,
        reason: "CITY_EMPTY",
        city: null,
        assignment_group: normalizedAssignmentGroup,
        assignment_type: assignmentType,
      };
    }

    if (!cityRecord) {
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
      };
    }

    if (assignmentType === "SQA") {
      const result = {
        ok: true,
        assignment_type: "SQA",
        assignment_group: normalizedAssignmentGroup,
        city: cityRecord.city,
        nsa: cityRecord.nsa,
        ccm_handling: cityRecord.ccm_handling,
        pic: cityRecord.pic_sqa,
        pic_sqa: cityRecord.pic_sqa,
        pic_nop: cityRecord.pic_nop,
        source: "ccm_handling_sqa_region_sumbagut",
      };
      logger.info("PIC search success for SQA", result);
      return result;
    }

    if (assignmentType === "NOP") {
      const result = {
        ok: true,
        assignment_type: "NOP",
        assignment_group: normalizedAssignmentGroup,
        city: cityRecord.city,
        nsa: cityRecord.nsa,
        ccm_handling: cityRecord.ccm_handling,
        pic: cityRecord.pic_nop,
        pic_sqa: cityRecord.pic_sqa,
        pic_nop: cityRecord.pic_nop,
        source: "ccm_handling_sqa_region_sumbagut",
      };
      logger.info("PIC search success for NOP", result);
      return result;
    }

    logger.warn("PIC search failed: assignment group not supported", {
      city: cityRecord.city,
      assignmentGroup: normalizedAssignmentGroup,
    });
    return {
      ok: false,
      reason: "ASSIGNMENT_GROUP_NOT_SUPPORTED",
      city: cityRecord.city,
      assignment_group: normalizedAssignmentGroup,
      assignment_type: assignmentType,
      nsa: cityRecord.nsa,
      ccm_handling: cityRecord.ccm_handling,
    };
  };
}

export const searchPicByCityAndAssignment = createPicSearch();

export const createPicLookup = createPicSearch;
export const lookupPicByCityAndAssignment = searchPicByCityAndAssignment;

// adapter untuk search PIC langsung dari row Excel yang sudah punya city dan assignment group.
export function searchPicFromTicketRow(row) {
  logger.info("Searching PIC from ticket row", { orderId: row?.["Order ID"] });
  return searchPicByCityAndAssignment({
    city: row?.[CITY_COLUMN],
    assignmentGroup: row?.[ASSIGNMENT_GROUP_COLUMN],
  });
}

export const lookupPicFromTicketRow = searchPicFromTicketRow;

export { SQA_ASSIGNMENT_GROUP, NOP_ASSIGNMENT_PREFIX };
