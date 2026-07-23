import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("whatsappSessionRegistryService");
const DEFAULT_REGISTRY_PATH = path.join(
  process.cwd(),
  "config",
  "whatsapp_sessions.json",
);
const DEFAULT_SESSION_ROOT = path.join(process.cwd(), "sessions", "whatsapp");

function getRegistryPath() {
  return process.env.WA_SESSION_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
}

function getSessionRoot() {
  return process.env.WA_SESSION_ROOT || DEFAULT_SESSION_ROOT;
}

function createEmptyRegistry() {
  return {
    version: 1,
    active_session_id: "",
    sessions: {},
  };
}

export function normalizePhoneNumber(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (phone.startsWith("0")) {
    return `62${phone.slice(1)}`;
  }
  return phone;
}

export function isValidPhoneNumber(value) {
  return /^62\d{8,15}$/.test(normalizePhoneNumber(value));
}

function getSessionAuthDir(sessionId) {
  return path.join(getSessionRoot(), sessionId);
}

async function readRegistry() {
  const registryPath = getRegistryPath();
  try {
    logger.info("Loading WhatsApp session registry", { registryPath });
    const raw = await fs.readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      active_session_id: parsed.active_session_id || "",
      sessions: parsed.sessions || {},
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.warn("WhatsApp session registry not found, using empty registry", {
        registryPath,
      });
      return createEmptyRegistry();
    }

    logger.error("Failed to load WhatsApp session registry", error);
    throw error;
  }
}

async function writeRegistry(registry) {
  const registryPath = getRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
  );
  logger.info("WhatsApp session registry saved", {
    registryPath,
    sessions: Object.keys(registry.sessions || {}).length,
    activeSessionId: registry.active_session_id || "",
  });
}

function toSessionList(registry) {
  return Object.values(registry.sessions || {}).sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}

function resolveSessionBySelector(registry, selector) {
  const value = String(selector || "").trim();
  if (!value) {
    return null;
  }

  const sessions = toSessionList(registry);
  const phone = normalizePhoneNumber(value);
  if (isValidPhoneNumber(phone)) {
    return registry.sessions[phone] || null;
  }

  if (/^\d+$/.test(value)) {
    const session = sessions[Number(value) - 1];
    return session || null;
  }

  return null;
}

export async function listWhatsAppSessions() {
  return toSessionList(await readRegistry());
}

export async function getWhatsAppSessionRegistry() {
  return readRegistry();
}

export async function upsertWhatsAppSession({ phone, label, status = "saved" }) {
  const sessionId = normalizePhoneNumber(phone);
  const registry = await readRegistry();
  const now = new Date().toISOString();
  const existing = registry.sessions[sessionId] || {};

  registry.sessions[sessionId] = {
    id: sessionId,
    phone: sessionId,
    label: String(label || existing.label || sessionId).trim(),
    jid: existing.jid || "",
    status,
    auth_dir: getSessionAuthDir(sessionId),
    created_at: existing.created_at || now,
    last_used_at: now,
  };
  registry.active_session_id = sessionId;

  await writeRegistry(registry);
  return registry.sessions[sessionId];
}

export async function markWhatsAppSessionStatus(sessionId, status) {
  const registry = await readRegistry();
  const session = registry.sessions[sessionId];
  if (!session) {
    return null;
  }

  session.status = status;
  session.last_used_at = new Date().toISOString();
  if (status === "connected" || status === "starting") {
    registry.active_session_id = sessionId;
  }
  if (status === "stopped" && registry.active_session_id === sessionId) {
    registry.active_session_id = "";
  }
  await writeRegistry(registry);
  return session;
}

export async function resolveWhatsAppSession(selector) {
  const registry = await readRegistry();
  return resolveSessionBySelector(registry, selector);
}

export async function deleteWhatsAppSession(selector) {
  const registry = await readRegistry();
  const session = resolveSessionBySelector(registry, selector);
  if (!session) {
    return null;
  }

  delete registry.sessions[session.id];
  if (registry.active_session_id === session.id) {
    registry.active_session_id = "";
  }
  await writeRegistry(registry);
  await fs.rm(session.auth_dir, { recursive: true, force: true });
  logger.warn("WhatsApp session deleted", {
    sessionId: session.id,
    authDir: session.auth_dir,
  });
  return session;
}

export function formatWhatsAppSessionsList({
  sessions,
  activeSessionId = "",
  title = "📱 Session WhatsApp tersedia",
}) {
  if (!sessions.length) {
    return [
      `${title}:`,
      "",
      "Belum ada session tersimpan.",
      "",
      "Jalankan `/login nomor_hp` untuk membuat session baru.",
      "Contoh: `/login 6282160478546`",
    ].join("\n");
  }

  return [
    `${title}:`,
    "",
    ...sessions.flatMap((session, index) => [
      `${index + 1}. ${session.label}`,
      `   Phone: \`${session.phone}\``,
      `   Status: ${session.id === activeSessionId ? "Active" : session.status || "Saved"}`,
      `   Auth: \`${session.auth_dir}\``,
      "",
    ]),
    "Jalankan `/login 1` untuk memakai session.",
    "Jalankan `/login nomor_hp` untuk membuat session baru.",
    "Jalankan `/stop 1` untuk mematikan koneksi tanpa hapus credential.",
  ].join("\n");
}
