import { getAppConfig } from "../config/appConfig.js";
import { createLogger } from "../utils/logger.js";
import { isGroupJid, normalizeJid } from "../utils/jid.js";

const logger = createLogger("accessControlService");

// OWNER_JIDS diperlakukan sebagai whitelist private/admin dari env.
export function getOwnerJids() {
  return new Set(
    String(process.env.OWNER_JIDS || "")
      .split(",")
      .map((jid) => normalizeJid(jid))
      .filter(Boolean),
  );
}

// mengambil daftar JID dari object config seperti authorized_groups atau authorized_users.
function getConfigJids(configKey) {
  const items = getAppConfig().raw[configKey] || {};

  return Object.values(items)
    .map((item) => normalizeJid(item?.jid || item))
    .filter(Boolean);
}

// grup hanya boleh menjalankan bot jika remoteJid grup ada di authorized_groups.
export function isAllowedGroup(sourceJid) {
  const normalizedSource = normalizeJid(sourceJid);
  const authorizedGroups = getConfigJids("authorized_groups");
  const allowed = isGroupJid(normalizedSource) && authorizedGroups.includes(normalizedSource);

  logger.info("Allowed group check", {
    sourceJid: normalizedSource,
    allowed,
    authorizedGroupCount: authorizedGroups.length,
  });

  return allowed;
}

// private chat hanya boleh dipakai JID yang ada di authorized_users atau OWNER_JIDS.
export function isAllowedPrivateUser(senderJid) {
  const normalizedSender = normalizeJid(senderJid);
  const ownerJids = getOwnerJids();
  const authorizedUsers = getConfigJids("authorized_users");
  const allowed =
    ownerJids.has(normalizedSender) || authorizedUsers.includes(normalizedSender);

  logger.info("Allowed private user check", {
    senderJid: normalizedSender,
    allowed,
    owner: ownerJids.has(normalizedSender),
    authorizedUserCount: authorizedUsers.length,
  });

  return allowed;
}

// #penjelasan: mengembalikan keputusan akses lengkap agar handler bisa log alasan allow/deny.
export function getWhatsAppAccessDecision({ sourceJid, senderJid }) {
  const normalizedSource = normalizeJid(sourceJid);
  const normalizedSender = normalizeJid(senderJid);
  const ownerJids = getOwnerJids();
  const owner = ownerJids.has(normalizedSender);

  if (isGroupJid(normalizedSource)) {
    const authorizedGroups = getConfigJids("authorized_groups");
    const allowed = authorizedGroups.includes(normalizedSource);
    const decision = {
      allowed,
      platform: "whatsapp",
      source_type: "group",
      reason: allowed ? "AUTHORIZED_GROUP" : "GROUP_NOT_AUTHORIZED",
      source_jid: normalizedSource,
      sender_jid: normalizedSender,
      owner,
    };

    logger.info("WhatsApp access decision resolved", decision);
    return decision;
  }

  const authorizedUsers = getConfigJids("authorized_users");
  const authorizedUser = authorizedUsers.includes(normalizedSender);
  const allowed = owner || authorizedUser;
  const decision = {
    allowed,
    platform: "whatsapp",
    source_type: "private",
    reason: owner
      ? "OWNER"
      : authorizedUser
        ? "AUTHORIZED_USER"
        : "PRIVATE_USER_NOT_AUTHORIZED",
    source_jid: normalizedSource,
    sender_jid: normalizedSender,
    owner,
    authorized_user: authorizedUser,
  };

  logger.info("WhatsApp access decision resolved", decision);
  return decision;
}

// aturan utama akses bot: source grup harus whitelisted, source private harus user whitelisted.
export function isAllowedBotAccess({ sourceJid, senderJid }) {
  return getWhatsAppAccessDecision({ sourceJid, senderJid }).allowed;
}
