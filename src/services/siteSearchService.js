import path from "path";
import fs from "fs";

import {
  CITY_COLUMN,
  ASSIGNMENT_GROUP_COLUMN,
  normalizeText,
  loadCcmHandlingRows,
} from "./picSearchService.js";
import { createLogger } from "../utils/logger.js";
import { readJsonArray } from "../utils/jsonFile.js";
import { hasMeaningfulLetters } from "../utils/text.js";
import { extractCityFromDescription } from "../utils/descriptionCityExtractor.js";

const logger = createLogger("siteSearchService");

export const PROBLEM_ANALYSIS_NSH_COLUMN = "Problem Analysis NSH";
export const SITE_ID1_COLUMN = "site_id1(L1 Assign)";

const NOP_SITE_FILE_NAME = "pic_nop_region_sumbagut.json";

let _resolvedNopSitePath = null;
function resolveNopSitePath() {
  if (_resolvedNopSitePath) return _resolvedNopSitePath;
  const candidates = [
    process.env.NOP_SITE_DATA_PATH,
    path.resolve(process.cwd(), "data", NOP_SITE_FILE_NAME),
    path.resolve(process.cwd(), "reference-data", NOP_SITE_FILE_NAME),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  _resolvedNopSitePath = found || candidates[0];
  logger.info("Resolved NOP site data path", {
    filePath: _resolvedNopSitePath,
    found: Boolean(found),
  });
  return _resolvedNopSitePath;
}

// Lazy singleton — data 4MB dimuat hanya saat pertama kali dibutuhkan
let _defaultSiteIndex = null;
function getDefaultSiteIndex() {
  if (!_defaultSiteIndex) {
    const rows = loadNopSiteRows();
    _defaultSiteIndex = buildSiteIndex(rows);
  }
  return _defaultSiteIndex;
}

// mengambil site ID dari teks dengan pola #Site Cover, Site Cover, Site ID, atau eNodeB cell.
export function extractAllSiteCandidates(textInput) {
  const text = String(textInput ?? "");
  if (!text.trim()) return [];

  const candidates = [];
  const seen = new Set();
  const addCandidate = (val, type) => {
    if (!val) return;
    const norm = normalizeText(val);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      candidates.push({ siteId: norm, type });
    }
  };

  // 1. Explicit #Site Cover, Site Cover, atau Site ID (mendukung sisipan tech seperti (4G), (LTE), dsb.)
  const explicitMatches = text.matchAll(
    /#?\s*site\s*(?:cover|id)?\s*(?:\([^)]*\))?\s*[:=-]?\s*([A-Z]{2,5}\d{2,5})/gi,
  );
  for (const m of explicitMatches) {
    addCandidate(m[1], "explicit");
  }

  // 2. Match eNodeB / cell pattern seperti E_RAP755SL1, N_RAP755MR1, E_BJI179_TanahTinggi
  const cellMatches = text.matchAll(/(?:^|[^A-Z0-9])([EN])_([A-Z]{3}\d{3})\w*/gi);
  for (const m of cellMatches) {
    addCandidate(m[2], "cell");
  }

  // 3. Match cell sector pattern tanpa prefix E_/N_ seperti LHK330ML1, PMR059ML2, KPD658MR1
  const cellSectorMatches = text.matchAll(
    /(?:^|[^A-Z0-9])([A-Z]{3}\d{3})[A-Z0-9]{1,4}(?:[^A-Z0-9]|$)/gi,
  );
  for (const m of cellSectorMatches) {
    addCandidate(m[1], "cell");
  }

  // 4. Fallback token 6 karakter [A-Z]{3}\d{3}
  const tokenMatches = text.matchAll(/(?:^|[^A-Z0-9])([A-Z]{3}\d{3})(?:[^A-Z0-9]|$)/gi);
  for (const m of tokenMatches) {
    addCandidate(m[1], "token");
  }

  return candidates;
}

export function extractSiteCover(textInput) {
  logger.debug("Extracting site cover from text");
  const candidates = extractAllSiteCandidates(textInput);
  if (candidates.length === 0) return null;

  // Prioritaskan explicit jika ada, jika tidak cell pattern
  const explicit = candidates.find((c) => c.type === "explicit");
  const cell = candidates.find((c) => c.type === "cell");
  const chosen = explicit || cell;

  const siteId = chosen ? chosen.siteId : null;
  logger.debug("Site cover extraction result", { siteId, type: chosen?.type });
  return siteId;
}

export function extractSiteCoverFromRowDetailed(row, siteIndex = null) {
  const candidateColumns = [
    PROBLEM_ANALYSIS_NSH_COLUMN,
    "problem_analysis_nsh",
    "root_caused_detail_nsh",
    "root_caused_detail",
    "CCH Suggestion(L1 Assign_cch_suggestion)",
    "cch_suggestion_l1_assign_cch_suggestion",
    "cch_suggestion_2(L1 Assign)",
    "cch_suggestion_2_l1_assign",
    "cch_suggestion_3(L1 Assign)",
    "cch_suggestion_3_l1_assign",
    "CCH Suggestion 2(L1 Assign)",
    "CCH Suggestion 3(L1 Assign)",
    "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)",
    "description_fault_sumptomps_create_ticket_description_fault_sym",
    "description_fault_sumptomps_create_ticket_description_fault_symptomps",
    "description_fault_sumptomps_create_ticket",
    "Description",
    "description",
    "Problem Analysis",
    "problem_analysis",
    "remark_confirm_close",
    "details_area_location_create_ticket_details_area_location",
    "details_area_location",
    "cell_id_l2_assign_cell_id",
    "cell_id_l2_assign",
    "cell_id_nsh",
    "cell_id",
    "fault_cell_or_site",
    "fault_cell_or_site3",
    "CCH Smartcare",
    "cch_smartcare",
  ];

  let firstFound = null;
  const allCandidates = [];

  for (const col of candidateColumns) {
    const text = row?.[col];
    if (text) {
      const candidates = extractAllSiteCandidates(text);
      for (const cand of candidates) {
        allCandidates.push({ ...cand, column: col });
        if (!firstFound) {
          firstFound = cand.siteId;
        }
      }
    }
  }

  if (siteIndex && allCandidates.length > 0) {
    const validInIndex = allCandidates.filter((c) => siteIndex.has(c.siteId));

    if (validInIndex.length > 0) {
      const assignmentGroup = normalizeText(
        row?.[ASSIGNMENT_GROUP_COLUMN] || row?.assignment_group || "",
      );
      let bestCandidate = null;

      if (assignmentGroup) {
        const areaMatched = validInIndex.find((c) => {
          const rec = siteIndex.get(c.siteId);
          if (!rec?.departement_ns) return false;
          const dept = normalizeText(rec.departement_ns);
          const tokens = [
            "ACEH",
            "BINJAI",
            "MEDAN",
            "PEMATANG",
            "RANTAU",
            "SIDEMPUAN",
          ];
          return tokens.some(
            (t) => assignmentGroup.includes(t) && dept.includes(t),
          );
        });
        if (areaMatched) {
          bestCandidate = areaMatched;
        }
      }

      if (!bestCandidate) {
        bestCandidate =
          validInIndex.find((c) => c.type === "cell" || c.type === "explicit") ||
          validInIndex[0];
      }

      const explicitInvalid = allCandidates.find(
        (c) => c.type === "explicit" && !siteIndex.has(c.siteId),
      );

      return {
        siteId: bestCandidate.siteId,
        source: bestCandidate.column,
        type: bestCandidate.type,
        overriddenSite: explicitInvalid ? explicitInvalid.siteId : null,
      };
    }
  }

  return {
    siteId: firstFound,
    source: candidateColumns[0],
    type: "first_found",
    overriddenSite: null,
  };
}

export function extractSiteCoverFromRow(row, siteIndex = null) {
  const detailed = extractSiteCoverFromRowDetailed(row, siteIndex);
  return detailed.siteId;
}

// membuat index site_id -> data site agar search ke JSON NOP cepat dan konsisten.
function buildSiteIndex(rows) {
  logger.debug("Building NOP site index", { rows: rows.length });
  return new Map(
    rows
      .filter((row) => row && row.site_id)
      .map((row) => [normalizeText(row.site_id), row]),
  );
}

// membaca database site NOP yang dipakai untuk city fallback, vendor, cluster area, dan site detail.
export function loadNopSiteRows(filePath = resolveNopSitePath()) {
  try {
    logger.debug("Loading NOP site data", { filePath });
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
    options.siteIndex || (rows ? buildSiteIndex(rows) : getDefaultSiteIndex());
  let ccmRows = null;

  return function resolveCityFromTicketRow(row) {
    logger.debug("Resolving city from ticket row", { orderId: row?.["Order ID"] || row?.order_id });
    const rawDirectCity = row?.[CITY_COLUMN] || row?.kabupaten_kota_create_ticket || row?.city;
    const directCity = normalizeText(rawDirectCity);
    const isDirectCityValid =
      directCity &&
      directCity !== "-" &&
      directCity !== "'-" &&
      hasMeaningfulLetters(directCity);

    if (isDirectCityValid) {
      logger.debug("City resolved from city column", { city: directCity });
      return {
        ok: true,
        city: directCity,
        source: "city_column",
        site_id: null,
      };
    }

    const detailed = extractSiteCoverFromRowDetailed(row, siteIndex);
    const siteId = detailed.siteId;

    if (siteId) {
      const siteRecord = siteIndex.get(siteId);
      if (siteRecord) {
        const result = {
          ok: true,
          city: normalizeText(siteRecord.kabupaten),
          source: "problem_analysis_nsh",
          site_id: siteId,
          site_name: siteRecord.site_name,
          departement_ns: siteRecord.departement_ns,
          overridden_site: detailed.overriddenSite || null,
        };
        logger.debug("City resolved from site cover", result);
        return result;
      }
    }

    // Fallback: coba ekstrak kota dari deskripsi alamat pelanggan
    if (!ccmRows) {
      try {
        ccmRows = loadCcmHandlingRows();
      } catch (_) {
        ccmRows = [];
      }
    }

    const descText = [
      row?.["Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"],
      row?.description_fault_sumptomps_create_ticket_description_fault_symptomps,
      row?.[PROBLEM_ANALYSIS_NSH_COLUMN],
      row?.problem_analysis_nsh,
      row?.Description,
      row?.description,
      row?.["Lokasi Pelanggan"],
    ]
      .filter(Boolean)
      .join("\n");

    const descCity = extractCityFromDescription(descText, ccmRows);
    if (descCity) {
      logger.debug("City resolved from description fallback", { city: descCity });
      return {
        ok: true,
        city: normalizeText(descCity),
        source: "extracted_from_description",
        site_id: siteId || null,
        overridden_site: detailed.overriddenSite || null,
      };
    }

    if (!siteId) {
      logger.warn("City resolution failed: city empty and site cover not found", {
        orderId: row?.["Order ID"] || row?.order_id,
      });
      return {
        ok: false,
        reason: "CITY_EMPTY_AND_SITE_COVER_NOT_FOUND",
        city: null,
        source: "problem_analysis_nsh",
        site_id: null,
      };
    }

    logger.warn("City resolution failed: site cover not found in NOP data", {
      orderId: row?.["Order ID"] || row?.order_id,
      siteId,
    });
    return {
      ok: false,
      reason: "SITE_COVER_NOT_FOUND_IN_NOP_DATA",
      city: null,
      source: "problem_analysis_nsh",
      site_id: siteId,
    };
  };
}

export const resolveCityFromTicketRow = createCityResolver();

// membuat resolver site; prioritas site_id1(L1 Assign), direct alt columns (L2, NSH, site2/3), fallback teks (Problem Analysis NSH / CCH), dan geo fallback.
export function createSiteResolver(options = {}) {
  const rows = options.rows || (options.filePath ? loadNopSiteRows(options.filePath) : null);
  const siteIndex = options.siteIndex || (rows ? buildSiteIndex(rows) : getDefaultSiteIndex());

  return function resolveSiteFromTicketRow(row) {
    logger.debug("Resolving site from ticket row", { orderId: row?.["Order ID"] || row?.order_id });
    
    // 1. Prioritas 1: Direct L1 Site ID
    const rawDirectSite =
      row?.[SITE_ID1_COLUMN] ||
      row?.site_id1_l1_assign ||
      row?.site_id1 ||
      row?.site_id;
    const directSiteId = normalizeText(rawDirectSite);
    const isDirectSiteValid =
      directSiteId &&
      directSiteId !== "-" &&
      directSiteId !== "'-" &&
      directSiteId !== "--" &&
      directSiteId.toLowerCase() !== "null" &&
      directSiteId.toLowerCase() !== "undefined" &&
      !/^\d{6,}$/i.test(directSiteId) &&
      !/^[0-9A-F]{10,}$/i.test(directSiteId);

    let siteId = isDirectSiteValid ? directSiteId : null;
    let source = siteId ? "site_id1_column" : null;

    // Helper untuk memvalidasi kandidat string site ID
    const cleanSiteCandidate = (val) => {
      const norm = normalizeText(val);
      if (
        !norm ||
        norm === "-" ||
        norm === "'-" ||
        norm === "--" ||
        norm.toLowerCase() === "null" ||
        norm.toLowerCase() === "undefined" ||
        /^\d{6,}$/i.test(norm) ||
        /^[0-9A-F]{10,}$/i.test(norm)
      ) {
        return null;
      }
      return norm;
    };

    // 2. Prioritas 2: Direct Alternative Columns (L2, NSH, site_id2, site_id3, fault_cell)
    if (!siteId || (siteIndex && !siteIndex.has(siteId))) {
      const altCandidates = [
        { key: "site_id_l2_assign", val: row?.site_id_l2_assign || row?.["Site ID(L2 Assign)"] || row?.site_id_l2 },
        { key: "site_id_nsh", val: row?.site_id_nsh || row?.["Site ID NSH"] },
        { key: "site_id2_l1_assign", val: row?.site_id2_l1_assign || row?.["site_id2(L1 Assign)"] || row?.site_id2 },
        { key: "site_id3_l1_assign", val: row?.site_id3_l1_assign || row?.["site_id3(L1 Assign)"] || row?.site_id3 },
        { key: "fault_cell_or_site", val: row?.fault_cell_or_site || row?.fault_cell_or_site3 },
      ];

      for (const cand of altCandidates) {
        const norm = cleanSiteCandidate(cand.val);
        if (norm) {
          if (siteIndex && siteIndex.has(norm)) {
            siteId = norm;
            source = cand.key;
            break;
          }
          const m = norm.match(/([A-Z]{3}\d{3})/i);
          if (m) {
            const token = m[1].toUpperCase();
            if (siteIndex && siteIndex.has(token)) {
              siteId = token;
              source = `${cand.key}_token`;
              break;
            } else if (!siteId && /^[A-Z]{3}\d{3}$/.test(token)) {
              siteId = token;
              source = `${cand.key}_token`;
            }
          }
          if (!siteId && /^[A-Z]{3}\d{3}$/.test(norm)) {
            siteId = norm;
            source = cand.key;
          }
        }
      }
    }

    // 3. Prioritas 3: Fallback ekstraksi regex dari teks (Problem Analysis NSH, CCH Suggestion, Deskripsi, dll.)
    if (!siteId || (siteIndex && !siteIndex.has(siteId))) {
      const explicitFromNsh = extractSiteCover(
        row?.[PROBLEM_ANALYSIS_NSH_COLUMN] || row?.problem_analysis_nsh,
      );
      if (explicitFromNsh && siteIndex && siteIndex.has(explicitFromNsh)) {
        siteId = explicitFromNsh;
        source = "problem_analysis_nsh";
      } else {
        const coverFromRow = extractSiteCoverFromRow(row, siteIndex);
        if (coverFromRow) {
          siteId = coverFromRow;
          source = "extracted_from_row";
        } else if (!siteId && explicitFromNsh) {
          siteId = explicitFromNsh;
          source = "problem_analysis_nsh";
        } else if (!siteId && isDirectSiteValid) {
          siteId = directSiteId;
          source = "site_id1_column";
        }
      }
    }

    // 4. Prioritas 4: Fallback Geografis (Kecamatan di Alamat Pelanggan -> Master Site NOP)
    if ((!siteId || (siteIndex && !siteIndex.has(siteId))) && rows && rows.length > 0) {
      const descText = [
        row?.["Lokasi Pelanggan"],
        row?.description_fault_sumptomps_create_ticket_description_fault_sym,
        row?.["Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"],
        row?.details_area_location_create_ticket_details_area_location,
        row?.kecamatan_create_ticket,
        row?.desa_kelurahan_create_ticket,
      ].filter(Boolean).join(" ");

      if (descText) {
        for (const site of rows) {
          if (site.kecamatan && site.kecamatan.length >= 4) {
            const regex = new RegExp(`(?:kec\\.?|kecamatan\\s+)?\\b${site.kecamatan}\\b`, "i");
            if (regex.test(descText)) {
              siteId = site.site_id;
              source = `geo_kecamatan_${site.kecamatan}`;
              break;
            }
          }
        }
      }
    }

    // 5. Jika seluruh fallback telah dilakukan dan tidak ada site, biarkan NULL
    if (!siteId) {
      logger.warn("Site resolution failed: no site_id1 and no site cover", {
        orderId: row?.["Order ID"] || row?.order_id,
      });
      return {
        ok: false,
        reason: "SITE_ID_EMPTY_AND_SITE_COVER_NOT_FOUND",
        site_id: null,
      };
    }

    const siteRecord = siteIndex?.get(siteId);
    if (!siteRecord) {
      logger.warn("Site resolution failed: site not found in NOP data", {
        orderId: row?.["Order ID"] || row?.order_id,
        siteId,
      });
      return {
        ok: false,
        reason: "SITE_ID_NOT_FOUND_IN_NOP_DATA",
        site_id: siteId,
        source,
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
    logger.debug("Site resolved", result);
    return result;
  };
}

export const resolveSiteFromTicketRow = createSiteResolver();
