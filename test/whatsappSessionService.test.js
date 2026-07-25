import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createWhatsAppSessionService } from "../src/services/whatsappSessionService.js";
import { upsertWhatsAppSession } from "../src/services/whatsappSessionRegistryService.js";

function setupContext(name) {
  const baseDir = path.join("tmp", name);
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
  process.env.WA_SESSION_REGISTRY_PATH = path.join(
    baseDir,
    "whatsapp_sessions.json",
  );
  process.env.WA_SESSION_ROOT = path.join(baseDir, "sessions");

  return {
    cleanup() {
      delete process.env.WA_SESSION_REGISTRY_PATH;
      delete process.env.WA_SESSION_ROOT;
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function createMockStartBot(events) {
  return async ({ authDir }) => {
    const controller = {
      sock: {
        sendMessage: async () => {},
      },
      stopped: false,
      getStatus() {
        return {
          running: !controller.stopped,
          user: { id: "628000000000@s.whatsapp.net" },
          authDir,
        };
      },
      async stop(reason) {
        events.push({ type: "stop", authDir, reason });
        controller.stopped = true;
      },
      async logout(reason) {
        events.push({ type: "logout", authDir, reason });
        controller.stopped = true;
      },
    };

    events.push({ type: "start", authDir });
    return controller;
  };
}

async function createServiceWithSessions(name) {
  const context = setupContext(name);
  const events = [];
  const messages = [];
  const service = createWhatsAppSessionService({
    sendTelegramMessage: async (chatId, text) => {
      messages.push({ chatId, text });
    },
    startWhatsAppBot: createMockStartBot(events),
  });

  await upsertWhatsAppSession({
    phone: "6282160478546",
    label: "Rifqi Yafik",
  });
  await upsertWhatsAppSession({
    phone: "6281111111111",
    label: "Budi",
  });

  return { context, events, messages, service };
}

test("asks for confirmation before switching active WhatsApp session", async () => {
  const { context, events, service } = await createServiceWithSessions(
    "whatsapp-session-switch-confirm",
  );

  await service.login("5085979770", "1");
  const result = await service.login("5085979770", "2");

  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "stop").length, 0);
  assert.match(result, /Session WhatsApp sedang aktif/);
  assert.match(result, /Rifqi Yafik/);
  assert.match(result, /Budi/);
  assert.match(result, /Balas `YA`/);

  context.cleanup();
});

test("cancels pending WhatsApp session switch when user answers no", async () => {
  const { context, events, service } = await createServiceWithSessions(
    "whatsapp-session-switch-cancel",
  );

  await service.login("5085979770", "1");
  await service.login("5085979770", "2");
  const result = await service.completePendingSessionSwitch(
    "5085979770",
    "TIDAK",
  );

  assert.equal(events.filter((event) => event.type === "start").length, 1);
  assert.equal(events.filter((event) => event.type === "stop").length, 0);
  assert.match(result, /Switch Session Dibatalkan/);
  assert.equal(service.getStatus().active_session.phone, "6282160478546");

  context.cleanup();
});

test("stops active WhatsApp session before starting confirmed switch target", async () => {
  const { context, events, service } = await createServiceWithSessions(
    "whatsapp-session-switch-yes",
  );

  await service.login("5085979770", "1");
  await service.login("5085979770", "2");
  const result = await service.completePendingSessionSwitch("5085979770", "YA");

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "stop", "start"],
  );
  assert.match(events[1].reason, /confirmed session switch/i);
  assert.match(result, /Switch Session Diproses/);
  assert.match(result, /Session lama dimatikan: \*\*Rifqi Yafik\*\*/);
  assert.match(result, /Session baru: \*\*Budi\*\*/);
  assert.equal(service.getStatus().active_session.phone, "6281111111111");

  context.cleanup();
});
