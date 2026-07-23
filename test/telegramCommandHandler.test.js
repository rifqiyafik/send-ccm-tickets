import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTelegramCommandHandler } from "../src/handlers/telegramCommandHandler.js";
import { registerTelegramChat } from "../src/services/telegramAccessService.js";

function setupTelegramAccessConfig(name) {
  const configPath = path.join("tmp", `${name}-telegram-access.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.rmSync(configPath, { force: true });
  process.env.TELEGRAM_ACCESS_CONFIG_PATH = configPath;

  return {
    configPath,
    cleanup() {
      fs.rmSync(configPath, { force: true });
      delete process.env.TELEGRAM_ACCESS_CONFIG_PATH;
    },
  };
}

function createTextUpdate({ chatId, text, type = "private" }) {
  return {
    message: {
      text,
      chat: {
        id: chatId,
        type,
        title: type === "private" ? undefined : "Approved Group",
      },
      from: {
        id: "123",
        first_name: "Tester",
      },
    },
  };
}

function createMockRuntime() {
  const sentMessages = [];
  const whatsappSession = {
    async completePendingLoginName() {
      return null;
    },
    async listSessions() {
      return "sessions list";
    },
    async login(_chatId, argument) {
      return `login allowed: ${argument || "-"}`;
    },
    async stop(argument) {
      return `stop allowed: ${argument || "-"}`;
    },
    async logout(argument) {
      return `logout called: ${argument || "-"}`;
    },
    async deleteSession(argument) {
      return `delete called: ${argument || "-"}`;
    },
    getStatus() {
      return {
        running: false,
        user: null,
        active_session: null,
        authDir: "",
        qr_subscribers: 0,
      };
    },
  };
  const handler = createTelegramCommandHandler({
    config: {
      admin_chat_ids: ["999"],
    },
    whatsappSession,
  });
  const tools = {
    async downloadFile() {
      return Buffer.from("");
    },
    async sendDocument() {},
    async sendMessage(chatId, text, options) {
      sentMessages.push({ chatId, text, options });
    },
  };

  return { handler, sentMessages, tools };
}

test("allows authorized Telegram group to use login command", async () => {
  const context = setupTelegramAccessConfig("handler-authorized-group-login");
  await registerTelegramChat({
    chatId: "-1001234567890",
    label: "Approved Group",
    type: "group",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "-1001234567890",
      text: "/login",
      type: "supergroup",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /login allowed: -/);
  assert.doesNotMatch(sentMessages[0].text, /hanya untuk admin/i);

  context.cleanup();
});

test("allows authorized Telegram private user to use login command", async () => {
  const context = setupTelegramAccessConfig("handler-authorized-user-login");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/login 1",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /login allowed: 1/);
  assert.doesNotMatch(sentMessages[0].text, /hanya untuk admin/i);

  context.cleanup();
});

test("keeps logout admin-only for authorized Telegram chat", async () => {
  const context = setupTelegramAccessConfig("handler-logout-admin-only");
  await registerTelegramChat({
    chatId: "123456789",
    label: "Approved User",
    type: "private",
    registeredBy: "999",
  });

  const { handler, sentMessages, tools } = createMockRuntime();
  await handler(
    createTextUpdate({
      chatId: "123456789",
      text: "/logout",
    }),
    tools,
  );

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /hanya untuk admin/i);
  assert.doesNotMatch(sentMessages[0].text, /logout called/);

  context.cleanup();
});
