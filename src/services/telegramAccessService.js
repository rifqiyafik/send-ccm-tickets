import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("telegramAccessService");
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "config", "telegram.json");

function getConfigPath() {
  return process.env.TELEGRAM_ACCESS_CONFIG_PATH || DEFAULT_CONFIG_PATH;
}

function createEmptyConfig() {
  return {
    authorized_groups: {},
    authorized_users: {},
  };
}

function normalizeChatId(value) {
  return String(value || "").trim();
}

function normalizeChatType(value) {
  return String(value || "").toLowerCase();
}

function getChatBucket(chatType) {
  return ["group", "supergroup", "channel"].includes(normalizeChatType(chatType))
    ? "authorized_groups"
    : "authorized_users";
}

function getChatLabel(chat) {
  return chat?.title || chat?.username || chat?.first_name || chat?.id || "-";
}

async function loadConfig() {
  const configPath = getConfigPath();
  try {
    logger.info("Loading Telegram access config", { configPath });
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      authorized_groups: parsed.authorized_groups || {},
      authorized_users: parsed.authorized_users || {},
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.warn("Telegram access config not found, using empty config", {
        configPath,
      });
      return createEmptyConfig();
    }

    logger.error("Failed to load Telegram access config", error);
    throw error;
  }
}

async function saveConfig(config) {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  logger.info("Telegram access config saved", {
    configPath,
    authorizedGroups: Object.keys(config.authorized_groups || {}).length,
    authorizedUsers: Object.keys(config.authorized_users || {}).length,
  });
}

// #penjelasan: mengecek apakah chat Telegram boleh mengirim file/command operasional selain request register.
export async function isAuthorizedTelegramChat(chatId) {
  const normalizedChatId = normalizeChatId(chatId);
  const decision = await getTelegramAccessDecision(normalizedChatId);

  logger.info("Telegram access checked", {
    chatId: normalizedChatId,
    allowed: decision.allowed,
    reason: decision.reason,
    sourceType: decision.source_type,
  });

  return decision.allowed;
}

// #penjelasan: mengembalikan keputusan akses lengkap untuk log dan pemisahan admin/user/group.
export async function getTelegramAccessDecision(chatId, { admin = false } = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const config = await loadConfig();
  const sourceType = normalizedChatId.startsWith("-") ? "group" : "private";
  const authorizedGroup =
    sourceType === "group" && Boolean(config.authorized_groups[normalizedChatId]);
  const authorizedUser =
    sourceType === "private" && Boolean(config.authorized_users[normalizedChatId]);
  const allowed = Boolean(admin || authorizedGroup || authorizedUser);
  const reason = admin
    ? "ADMIN"
    : authorizedGroup
      ? "AUTHORIZED_GROUP"
      : authorizedUser
        ? "AUTHORIZED_USER"
        : sourceType === "group"
          ? "GROUP_NOT_AUTHORIZED"
          : "PRIVATE_USER_NOT_AUTHORIZED";
  const decision = {
    allowed,
    admin: Boolean(admin),
    platform: "telegram",
    source_type: sourceType,
    reason,
    chat_id: normalizedChatId,
    authorized_group: authorizedGroup,
    authorized_user: authorizedUser,
  };

  logger.info("Telegram access decision resolved", decision);
  return decision;
}

// #penjelasan: admin memakai ini untuk mendaftarkan group/private chat Telegram ke whitelist lokal.
export async function registerTelegramChat({
  chatId,
  label = "",
  type = "group",
  registeredBy = "",
}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) {
    throw new Error("Chat ID wajib diisi.");
  }

  const config = await loadConfig();
  const bucket = getChatBucket(type);
  config[bucket][normalizedChatId] = {
    id: normalizedChatId,
    label: String(label || normalizedChatId).trim(),
    type,
    registered_by: registeredBy,
    registered_at: new Date().toISOString(),
  };

  await saveConfig(config);

  logger.info("Telegram chat registered", {
    chatId: normalizedChatId,
    label,
    bucket,
    registeredBy,
  });

  return config[bucket][normalizedChatId];
}

export async function listAuthorizedTelegramChats() {
  const config = await loadConfig();
  return {
    groups: Object.values(config.authorized_groups || {}),
    users: Object.values(config.authorized_users || {}),
  };
}

export function formatTelegramRegisterRequest({ chat, from }) {
  const chatId = normalizeChatId(chat?.id);
  const chatType = chat?.type || "-";
  const chatLabel = getChatLabel(chat);
  const fromLabel =
    [from?.first_name, from?.last_name].filter(Boolean).join(" ") ||
    from?.username ||
    from?.id ||
    "-";

  return [
    "🔓 **Telegram Whitelist Request**",
    "",
    "📥 Ada chat Telegram yang meminta akses untuk mengirim file Excel.",
    "",
    "📋 **Detail Request:**",
    `🆔 Chat ID: \`${chatId}\``,
    `🏷️ Chat Label: **${chatLabel}**`,
    `📌 Chat Type: \`${chatType}\``,
    `👤 Requested By: **${fromLabel}**`,
    "",
    "✅ **Approve dengan command:**",
    `\`/register ${chatId} ${chatLabel}\``,
  ].join("\n");
}

export function formatRegisteredTelegramChatsList({ groups, users }) {
  const lines = [
    "📋 **Telegram Whitelist**",
    "",
    `👥 **Authorized Groups:** ${groups.length}`,
    ...(groups.length > 0
      ? groups.map((item) => `- \`${item.id}\` - ${item.label || "-"}`)
      : ["- Belum ada group terdaftar."]),
    "",
    `👤 **Authorized Users:** ${users.length}`,
    ...(users.length > 0
      ? users.map((item) => `- \`${item.id}\` - ${item.label || "-"}`)
      : ["- Belum ada user terdaftar."]),
  ];

  return lines.join("\n");
}
