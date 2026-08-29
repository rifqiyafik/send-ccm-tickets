import path from "path";
import fs from "fs";

import { createLogger } from "../utils/logger.js";
import { readJsonArray } from "../utils/jsonFile.js";
import { normalizeText } from "./picSearchService.js";
import { normalizeJid } from "../utils/jid.js";
import { getMentionContact } from "../config/appConfig.js";

const logger = createLogger("siteVisitService");
const TS_DATA_FILE_NAME = "ts_site_visit_sumbagut.json";

function resolveTsDataPath() {
  const candidates = [
    process.env.TS_SITE_VISIT_DATA_PATH,
    path.resolve(process.cwd(), "data", TS_DATA_FILE_NAME),
    path.resolve(process.cwd(), "reference-data", TS_DATA_FILE_NAME),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  const filePath = found || candidates[0];
  logger.info("Resolved TS Site Visit data path", {
    filePath,
    candidates,
    found: Boolean(found),
  });
  return filePath;
}

export function loadTsSiteVisitData(filePath = resolveTsDataPath()) {
  try {
    logger.info("Loading TS Site Visit data", { filePath });
    const rows = readJsonArray(filePath, "TS Site Visit data");
    logger.info("TS Site Visit data loaded", { count: rows.length });
    return rows;
  } catch (error) {
    logger.error("Failed to load TS Site Visit data", error);
    return [];
  }
}

const defaultTsRows = loadTsSiteVisitData();

export function resolveTsSiteVisit(ticket, rows = defaultTsRows) {
  const normalizedCity = normalizeText(ticket?.city);
  const clusterArea = normalizeText(ticket?.cluster_area || ticket?.nsa || ticket?.assignment_group);

  // 1. Match by City
  if (normalizedCity) {
    for (const entry of rows) {
      const matchCity = (entry.cities || []).some(
        (c) => normalizeText(c) === normalizedCity,
      );
      if (matchCity) {
        logger.info("Resolved TS Site Visit by city", {
          city: normalizedCity,
          area: entry.area,
          tsCount: entry.ts?.length,
        });
        return formatTsList(entry.ts);
      }
    }
  }

  // 2. Match by NOP / Cluster Area
  if (clusterArea) {
    for (const entry of rows) {
      if (
        normalizeText(entry.nop) === clusterArea ||
        normalizeText(entry.area) === clusterArea ||
        clusterArea.includes(normalizeText(entry.area)) ||
        (entry.area === "SIDEMPUAN" && clusterArea.includes("SIDEMPUAN")) ||
        (entry.area === "SIANTAR" && (clusterArea.includes("PEMATANG") || clusterArea.includes("SIANTAR") || clusterArea.includes("RANTAU")))
      ) {
        logger.info("Resolved TS Site Visit by cluster area", {
          clusterArea,
          area: entry.area,
          tsCount: entry.ts?.length,
        });
        return formatTsList(entry.ts);
      }
    }
  }

  // 3. Fallback: Medan TS
  const defaultEntry = rows.find((r) => r.area === "MEDAN") || rows[0];
  logger.warn("Resolved TS Site Visit fallback", {
    orderId: ticket?.order_id,
    fallbackArea: defaultEntry?.area,
  });
  return formatTsList(defaultEntry?.ts || []);
}

function formatTsList(tsRawList = []) {
  return tsRawList.map((ts) => {
    const rawPhone = String(ts.phone || "").replace(/[^0-9]/g, "");
    const defaultJid = rawPhone ? `${rawPhone}@s.whatsapp.net` : null;
    const configuredContact =
      getMentionContact(ts.name) || getMentionContact(rawPhone);

    return {
      name: ts.name,
      phone: rawPhone,
      jid: configuredContact?.jid || defaultJid,
      label:
        configuredContact?.label ||
        ts.label ||
        `${ts.name} Site Visit CCM Telkomsel`,
      tagText: `@${rawPhone}`,
    };
  });
}

export function formatTsMentionHeader(tsList = []) {
  if (!tsList || tsList.length === 0) return "-";
  return tsList.map((t) => t.tagText).join(" ");
}
