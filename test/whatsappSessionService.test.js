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
  return async ({ authDir, onConnectionUpdate, onControllerUpdate }) => {
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
    onControllerUpdate?.(controller);
    await onConnectionUpdate?.({ connection: "open" });
    return controller;
  };
}

function createLoggedOutStartBot(events) {
  return async ({ authDir, onConnectionUpdate, onControllerUpdate }) => {
    const controller = {
      sock: {
        sendMessage: async () => {},
      },
      stopped: false,
      getStatus() {
        return {
          running: !controller.stopped,
          user: null,
          authDir,
        };
      },
      async stop(reason) {
        events.push({ type: "stop", authDir, reason });
        controller.stopped = true;
      },
    };

    events.push({ type: "start", authDir });
    onControllerUpdate?.(controller);
    await onConnectionUpdate?.({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 401,
          },
        },
      },
    });
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

test("force recovers WhatsApp session when socket send detects closed connection", async () => {
  const { context, events, service } = await createServiceWithSessions(
    "whatsapp-session-force-recover",
  );

  await service.login("5085979770", "1");
  const socketBefore = service.getSocket();
  const socketAfter = await service.ensureReady("5085979770", {
    forceRecover: true,
  });

  assert.ok(socketBefore);
  assert.ok(socketAfter);
  assert.notEqual(socketAfter, socketBefore);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "stop", "start"],
  );
  assert.match(events[1].reason, /force recover/i);
  assert.equal(service.getStatus().connection_state, "connected");

  context.cleanup();
});

test("does not auto recover logged out WhatsApp session and asks for new QR session", async () => {
  const context = setupContext("whatsapp-session-logged-out");
  const events = [];
  const messages = [];
  const service = createWhatsAppSessionService({
    sendTelegramMessage: async (chatId, text) => {
      messages.push({ chatId, text });
    },
    startWhatsAppBot: createLoggedOutStartBot(events),
  });

  await upsertWhatsAppSession({
    phone: "6282160478546",
    label: "Rifqi Yafik",
  });

  await service.login("5085979770", "1");

  assert.deepEqual(events.map((event) => event.type), ["start"]);
  assert.equal(service.getStatus().connection_state, "logged_out");
  assert.equal(service.getStatus().desired_session_id, "");
  // New behavior: ask for re-auth confirmation instead of showing manual steps
  assert.match(messages.at(-1).text, /WhatsApp Session Usang/);
  assert.match(messages.at(-1).text, /YA/);
  assert.match(messages.at(-1).text, /TIDAK/);
  assert.match(messages.at(-1).text, /5 menit/);

  context.cleanup();
});

