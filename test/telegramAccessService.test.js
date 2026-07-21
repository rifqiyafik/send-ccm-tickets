import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  formatTelegramRegisterRequest,
  isAuthorizedTelegramChat,
  listAuthorizedTelegramChats,
  registerTelegramChat,
} from "../src/services/telegramAccessService.js";

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

test("registers Telegram group and allows it", async () => {
  const context = setupTelegramAccessConfig("group-register");

  const registered = await registerTelegramChat({
    chatId: "-1001234567890",
    label: "Grup Import Ticket",
    type: "group",
    registeredBy: "123456789",
  });

  assert.equal(registered.id, "-1001234567890");
  assert.equal(registered.label, "Grup Import Ticket");
  assert.equal(await isAuthorizedTelegramChat("-1001234567890"), true);
  assert.equal(await isAuthorizedTelegramChat("-1000000000000"), false);

  const list = await listAuthorizedTelegramChats();
  assert.equal(list.groups.length, 1);
  assert.equal(list.users.length, 0);

  context.cleanup();
});

test("registers Telegram private user separately from groups", async () => {
  const context = setupTelegramAccessConfig("user-register");

  await registerTelegramChat({
    chatId: "123456789",
    label: "Rifqi Admin",
    type: "private",
    registeredBy: "123456789",
  });

  const list = await listAuthorizedTelegramChats();
  assert.equal(list.groups.length, 0);
  assert.equal(list.users.length, 1);
  assert.equal(await isAuthorizedTelegramChat("123456789"), true);

  context.cleanup();
});

test("formats Telegram register request with approve command", () => {
  const text = formatTelegramRegisterRequest({
    chat: {
      id: "-1001234567890",
      type: "supergroup",
      title: "Import Ticket Group",
    },
    from: {
      first_name: "Rifqi",
      last_name: "Yafik",
    },
  });

  assert.match(text, /Telegram Whitelist Request/);
  assert.match(text, /Chat ID: `-1001234567890`/);
  assert.match(text, /\/register -1001234567890 Import Ticket Group/);
});
