import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { readJsonObject } from "../utils/jsonFile.js";
import { normalizeSearchKey } from "../utils/text.js";

const logger = createLogger("appConfig");

const normalizeKey = normalizeSearchKey;

// path config dibuat function agar test bisa override tanpa menyentuh config lokal.
function getConfigPath() {
  return path.resolve(process.cwd(), process.env.WHATSAPP_CONFIG_PATH || "config/whatsapp.json");
}

// membaca config/whatsapp.json; jika belum ada, sistem tetap berjalan dengan config kosong.
function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    logger.warn("config/whatsapp.json not found, using empty config", { configPath });
    return {
      authorized_groups: {},
      authorized_users: {},
      target_groups: {},
      mentions: {},
    };
  }

  try {
    logger.info("Loading app config", { configPath });
    const config = readJsonObject(configPath, "WhatsApp config");
    logger.info("App config loaded", {
      authorizedGroups: Object.keys(config.authorized_groups || {}).length,
      authorizedUsers: Object.keys(config.authorized_users || {}).length,
      targetGroups: Object.keys(config.target_groups || {}).length,
      mentions: Object.keys(config.mentions || {}).length,
    });
    return config;
  } catch (error) {
    logger.error("Failed to load app config", error);
    throw error;
  }
}

// membuat index config dengan key normalized untuk search cepat.
function buildIndex(object = {}) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [normalizeKey(key), value])
  );
}

// mengambil config mentah dan index target_groups/mentions yang sudah dinormalisasi.
export function getAppConfig() {
  const config = loadConfig();

  return {
    raw: config,
    targetGroups: buildIndex(config.target_groups),
    mentions: buildIndex(config.mentions),
  };
}

// mencari data mention PIC berdasarkan nama PIC dari hasil filter.
export function getMentionContact(name) {
  const config = getAppConfig();
  const contact = config.mentions[normalizeKey(name)] || null;
  logger.info("Mention contact search", { name, found: Boolean(contact?.jid) });
  return contact;
}

// mencari JID target group berdasarkan key SQA atau cluster NOP seperti NOP MEDAN.
export function getGroupConfig(groupKey) {
  const config = getAppConfig();
  const group = config.targetGroups[normalizeKey(groupKey)] || null;
  logger.info("Target group config search", { groupKey, found: Boolean(group?.jid) });
  return group;
}

export { normalizeKey };
