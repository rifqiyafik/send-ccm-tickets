import fs from "fs";
import path from "path";

import { createLogger } from "../utils/logger.js";
import { readJsonObject } from "../utils/jsonFile.js";

const logger = createLogger("runtimeEnvironmentService");
const DEFAULT_ENV = "production";
const ENV_CONFIG_FILES = {
  production: "config/whatsapp.json",
  development: "config/whatsapp-test.json",
};

function getRuntimeEnvPath() {
  return path.resolve(
    process.cwd(),
    process.env.APP_RUNTIME_ENV_PATH || "data/runtime/app_runtime_env.json",
  );
}

function normalizeAppEnv(value) {
  const env = String(value || "").trim().toLowerCase();
  return env === "development" || env === "production" ? env : DEFAULT_ENV;
}

function parseRequestedAppEnv(value) {
  const env = String(value || "").trim().toLowerCase();
  return getSupportedAppEnvironments().includes(env) ? env : "";
}

function readRuntimeEnvState() {
  const runtimePath = getRuntimeEnvPath();
  if (!fs.existsSync(runtimePath)) {
    return null;
  }

  try {
    const state = readJsonObject(runtimePath, "Runtime environment state");
    return {
      active_env: normalizeAppEnv(state.active_env),
      updated_at: state.updated_at || "",
      updated_by: state.updated_by || "",
    };
  } catch (error) {
    logger.error("Failed to read runtime environment state", {
      runtimePath,
      message: error.message,
      stack: error.stack,
    });
    return null;
  }
}

function writeRuntimeEnvState(state) {
  const runtimePath = getRuntimeEnvPath();
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  logger.info("Runtime environment state saved", {
    runtimePath,
    activeEnv: state.active_env,
    updatedBy: state.updated_by,
  });
}

export function getSupportedAppEnvironments() {
  return Object.keys(ENV_CONFIG_FILES);
}

export function isConfigPathOverrideActive() {
  return Boolean(String(process.env.WHATSAPP_CONFIG_PATH || "").trim());
}

export function getActiveAppEnvironment() {
  if (isConfigPathOverrideActive()) {
    return {
      active_env: "override",
      source: "WHATSAPP_CONFIG_PATH",
      runtime_path: getRuntimeEnvPath(),
    };
  }

  const runtimeState = readRuntimeEnvState();
  if (runtimeState?.active_env) {
    return {
      ...runtimeState,
      source: "runtime",
      runtime_path: getRuntimeEnvPath(),
    };
  }

  return {
    active_env: normalizeAppEnv(process.env.APP_ENV),
    source: process.env.APP_ENV ? "APP_ENV" : "default",
    runtime_path: getRuntimeEnvPath(),
  };
}

export function resolveWhatsAppConfigPath() {
  const overridePath = String(process.env.WHATSAPP_CONFIG_PATH || "").trim();
  if (overridePath) {
    const configPath = path.resolve(process.cwd(), overridePath);
    logger.info("WhatsApp config path resolved from override", {
      configPath,
      source: "WHATSAPP_CONFIG_PATH",
    });
    return configPath;
  }

  const activeEnv = getActiveAppEnvironment();
  const configFile = ENV_CONFIG_FILES[activeEnv.active_env] || ENV_CONFIG_FILES.production;
  const configPath = path.resolve(process.cwd(), configFile);
  logger.info("WhatsApp config path resolved from active environment", {
    activeEnv: activeEnv.active_env,
    source: activeEnv.source,
    configPath,
  });
  return configPath;
}

export function validateWhatsAppConfigForEnvironment(env) {
  const normalizedEnv = normalizeAppEnv(env);
  const relativePath = ENV_CONFIG_FILES[normalizedEnv];
  const configPath = path.resolve(process.cwd(), relativePath);

  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      env: normalizedEnv,
      config_path: configPath,
      reason: "CONFIG_NOT_FOUND",
      message: `Config file tidak ditemukan: ${relativePath}`,
    };
  }

  try {
    const config = readJsonObject(configPath, "WhatsApp config");
    for (const key of [
      "authorized_groups",
      "authorized_users",
      "target_groups",
      "mentions",
    ]) {
      if (!config[key] || Array.isArray(config[key]) || typeof config[key] !== "object") {
        return {
          ok: false,
          env: normalizedEnv,
          config_path: configPath,
          reason: "INVALID_CONFIG_SHAPE",
          message: `Config ${relativePath} harus punya object ${key}.`,
        };
      }
    }

    if (Object.keys(config.target_groups).length === 0) {
      return {
        ok: false,
        env: normalizedEnv,
        config_path: configPath,
        reason: "TARGET_GROUPS_EMPTY",
        message: `Config ${relativePath} belum punya target_groups.`,
      };
    }

    return {
      ok: true,
      env: normalizedEnv,
      config_path: configPath,
      relative_path: relativePath,
      counts: {
        authorized_groups: Object.keys(config.authorized_groups).length,
        authorized_users: Object.keys(config.authorized_users).length,
        target_groups: Object.keys(config.target_groups).length,
        mentions: Object.keys(config.mentions).length,
      },
    };
  } catch (error) {
    return {
      ok: false,
      env: normalizedEnv,
      config_path: configPath,
      reason: "INVALID_JSON",
      message: error.message,
    };
  }
}

export function changeRuntimeEnvironment(env, { updatedBy = "" } = {}) {
  if (isConfigPathOverrideActive()) {
    return {
      ok: false,
      reason: "CONFIG_PATH_OVERRIDE_ACTIVE",
      message:
        "WHATSAPP_CONFIG_PATH sedang aktif, environment dikunci manual. Kosongkan env itu untuk memakai /change_env.",
    };
  }

  const normalizedEnv = parseRequestedAppEnv(env);
  if (!normalizedEnv) {
    return {
      ok: false,
      reason: "UNSUPPORTED_ENV",
      message: `Environment tidak didukung: ${env || "-"}`,
    };
  }

  const validation = validateWhatsAppConfigForEnvironment(normalizedEnv);
  if (!validation.ok) {
    return validation;
  }

  const state = {
    active_env: normalizedEnv,
    updated_at: new Date().toISOString(),
    updated_by: String(updatedBy || ""),
  };
  writeRuntimeEnvState(state);

  return {
    ok: true,
    ...state,
    config_path: validation.config_path,
    relative_path: validation.relative_path,
    counts: validation.counts,
  };
}

export function formatEnvironmentStatus() {
  const active = getActiveAppEnvironment();
  const configPath = resolveWhatsAppConfigPath();
  let configCounts = null;
  let configReadable = false;
  let readError = "";

  try {
    const config = readJsonObject(configPath, "WhatsApp config");
    configReadable = true;
    configCounts = {
      authorized_groups: Object.keys(config.authorized_groups || {}).length,
      authorized_users: Object.keys(config.authorized_users || {}).length,
      target_groups: Object.keys(config.target_groups || {}).length,
      mentions: Object.keys(config.mentions || {}).length,
    };
  } catch (error) {
    readError = error.message;
  }

  return [
    "🌐 **Environment Aktif**",
    "",
    `Mode: **${active.active_env}**`,
    `Source: \`${active.source}\``,
    `WhatsApp Config: \`${path.relative(process.cwd(), configPath) || configPath}\``,
    `Runtime State: \`${path.relative(process.cwd(), active.runtime_path) || active.runtime_path}\``,
    "",
    configReadable
      ? [
          "📋 **Config Summary:**",
          `- Authorized Groups: **${configCounts.authorized_groups}**`,
          `- Authorized Users: **${configCounts.authorized_users}**`,
          `- Target Groups: **${configCounts.target_groups}**`,
          `- Mentions: **${configCounts.mentions}**`,
        ].join("\n")
      : ["⚠️ **Config tidak bisa dibaca**", `Error: \`${readError}\``].join("\n"),
  ].join("\n");
}

export function formatEnvironmentChangeResult(result) {
  if (!result.ok) {
    return [
      "❌ **Environment tidak diganti**",
      "",
      `Reason: \`${result.reason || "-"}\``,
      `Detail: ${result.message || "-"}`,
    ].join("\n");
  }

  return [
    "✅ **Environment berhasil diganti**",
    "",
    `Mode aktif: **${result.active_env}**`,
    `WhatsApp Config: \`${result.relative_path}\``,
    `Updated By: \`${result.updated_by || "-"}\``,
    "",
    "📋 **Config Summary:**",
    `- Authorized Groups: **${result.counts.authorized_groups}**`,
    `- Authorized Users: **${result.counts.authorized_users}**`,
    `- Target Groups: **${result.counts.target_groups}**`,
    `- Mentions: **${result.counts.mentions}**`,
  ].join("\n");
}
