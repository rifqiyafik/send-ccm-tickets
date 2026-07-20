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

// aturan utama akses bot: source grup harus whitelisted, source private harus user whitelisted.
export function isAllowedBotAccess({ sourceJid, senderJid }) {
  const normalizedSource = normalizeJid(sourceJid);
  const normalizedSender = normalizeJid(senderJid);

  if (isGroupJid(normalizedSource)) {
    return isAllowedGroup(normalizedSource);
  }

  return isAllowedPrivateUser(normalizedSender);
}
