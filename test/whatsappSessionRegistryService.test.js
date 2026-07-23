import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  deleteWhatsAppSession,
  isValidPhoneNumber,
  listWhatsAppSessions,
  normalizePhoneNumber,
  resolveWhatsAppSession,
  upsertWhatsAppSession,
} from "../src/services/whatsappSessionRegistryService.js";

function setupRegistry(name) {
  const basePath = path.join("tmp", name);
  fs.rmSync(basePath, { recursive: true, force: true });
  fs.mkdirSync(basePath, { recursive: true });

  process.env.WA_SESSION_REGISTRY_PATH = path.join(
    basePath,
    "whatsapp_sessions.json",
  );
  process.env.WA_SESSION_ROOT = path.join(basePath, "sessions");

  return {
    cleanup() {
      fs.rmSync(basePath, { recursive: true, force: true });
      delete process.env.WA_SESSION_REGISTRY_PATH;
      delete process.env.WA_SESSION_ROOT;
    },
  };
}

test("normalizes Indonesian phone number for WhatsApp session id", () => {
  assert.equal(normalizePhoneNumber("082160478546"), "6282160478546");
  assert.equal(normalizePhoneNumber("6282160478546"), "6282160478546");
  assert.equal(isValidPhoneNumber("082160478546"), true);
  assert.equal(isValidPhoneNumber("12345"), false);
});

test("stores, resolves, lists, and deletes WhatsApp session registry entries", async () => {
  const context = setupRegistry("whatsapp-session-registry");

  const session = await upsertWhatsAppSession({
    phone: "082160478546",
    label: "Budi",
  });

  assert.equal(session.id, "6282160478546");
  assert.equal(session.label, "Budi");
  assert.match(session.auth_dir, /6282160478546$/);

  const sessions = await listWhatsAppSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].label, "Budi");

  assert.equal((await resolveWhatsAppSession("1")).id, "6282160478546");
  assert.equal(
    (await resolveWhatsAppSession("6282160478546")).label,
    "Budi",
  );

  const deleted = await deleteWhatsAppSession("1");
  assert.equal(deleted.id, "6282160478546");
  assert.equal((await listWhatsAppSessions()).length, 0);

  context.cleanup();
});
